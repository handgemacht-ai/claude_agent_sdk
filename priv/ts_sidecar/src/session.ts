/**
 * Per-session wrapper around the TS Agent SDK.
 *
 * Two execution paths:
 *
 *   • **real mode** — uses `@anthropic-ai/claude-agent-sdk`'s V2
 *     preview (`unstable_v2_createSession`). Requires auth + network.
 *   • **mock mode** — deterministic echo session. No network, no SDK
 *     import. Used for CI and validation without auth. Activated via
 *     `SIDECAR_MOCK=1` or automatic fallback when the SDK import
 *     throws at startup.
 *
 * Both paths expose the same in-process surface (`create`, `send`,
 * `stream`, `close`, `resume`) so `index.ts` doesn't branch on mode
 * after startup.
 */

import type { Writable } from "node:stream";
import { send } from "./framing.js";
import {
  NOTIF_STREAM_END,
  NOTIF_STREAM_ERROR,
  NOTIF_STREAM_MESSAGE,
  SessionCreateParams,
  SessionCreateResult,
} from "./protocol.js";

export interface SessionEnvelope {
  create(params: SessionCreateParams): Promise<SessionCreateResult>;
  send(message: Record<string, unknown>): Promise<void>;
  stream(streamId: string, out: Writable): Promise<void>;
  cancelStream(streamId: string): void;
  close(): Promise<void>;
  resume(options?: Record<string, unknown>): Promise<void>;
}

export interface SessionContext {
  sessionId: string;
  hookEvents: string[];
  mcpTools: ReadonlyArray<unknown>;
  options: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock session — deterministic echo, no network
// ---------------------------------------------------------------------------

export class MockSession implements SessionEnvelope {
  private ctx!: SessionContext;
  private createdAt!: string;
  private lastUserText: string = "";
  private cancelled = new Set<string>();
  private closed = false;

  async create(params: SessionCreateParams): Promise<SessionCreateResult> {
    this.ctx = {
      sessionId: params.sessionId,
      hookEvents: params.hookEvents ?? [],
      mcpTools: params.mcpTools ?? [],
      options: params.options ?? {},
    };
    this.createdAt = new Date().toISOString();
    return { sessionId: params.sessionId, createdAt: this.createdAt };
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("session closed");
    const content = typeof message.content === "string" ? (message.content as string) : "";
    this.lastUserText = content;
  }

  async stream(streamId: string, out: Writable): Promise<void> {
    if (this.closed) throw new Error("session closed");
    const reply = `echo (mock): ${this.lastUserText}`;
    const chunks = chunkString(reply, 16);

    for (const chunk of chunks) {
      if (this.cancelled.has(streamId)) break;
      send(out, {
        jsonrpc: "2.0",
        method: NOTIF_STREAM_MESSAGE,
        params: {
          sessionId: this.ctx.sessionId,
          streamId,
          message: { type: "text_delta", text: chunk },
        },
      });
      await sleep(5);
    }

    send(out, {
      jsonrpc: "2.0",
      method: NOTIF_STREAM_END,
      params: {
        sessionId: this.ctx.sessionId,
        streamId,
        reason: this.cancelled.has(streamId) ? "cancelled" : "message_stop",
      },
    });
  }

  cancelStream(streamId: string): void {
    this.cancelled.add(streamId);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async resume(_options?: Record<string, unknown>): Promise<void> {
    this.closed = false;
  }
}

// ---------------------------------------------------------------------------
// Real session — lazy-imports the SDK, falls back to mock if unavailable
// ---------------------------------------------------------------------------

type SdkModule = {
  // Intentionally loose — the V2 preview surface is unstable. We only
  // probe for the symbol we need and throw an explicit error if it's
  // missing, rather than relying on the full type surface here.
  unstable_v2_createSession?: (opts: unknown) => Promise<unknown>;
  unstable_v2_resumeSession?: (sessionId: string, opts?: unknown) => Promise<unknown>;
};

export class RealSession implements SessionEnvelope {
  private sdk: SdkModule;
  private handle: any;
  private ctx!: SessionContext;
  private createdAt!: string;
  private closed = false;
  private activeStreams = new Map<string, AbortController>();

  constructor(sdk: SdkModule) {
    this.sdk = sdk;
  }

  async create(params: SessionCreateParams): Promise<SessionCreateResult> {
    if (!this.sdk.unstable_v2_createSession) {
      throw new Error(
        "installed @anthropic-ai/claude-agent-sdk does not expose unstable_v2_createSession",
      );
    }
    this.ctx = {
      sessionId: params.sessionId,
      hookEvents: params.hookEvents ?? [],
      mcpTools: params.mcpTools ?? [],
      options: params.options ?? {},
    };
    this.handle = await this.sdk.unstable_v2_createSession({
      ...params.options,
      sessionId: params.sessionId,
    });
    this.createdAt = new Date().toISOString();
    return { sessionId: params.sessionId, createdAt: this.createdAt };
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("session closed");
    if (typeof this.handle?.send !== "function") {
      throw new Error("session handle has no send()");
    }
    await this.handle.send(message);
  }

  async stream(streamId: string, out: Writable): Promise<void> {
    if (this.closed) throw new Error("session closed");
    if (typeof this.handle?.stream !== "function") {
      throw new Error("session handle has no stream()");
    }

    const controller = new AbortController();
    this.activeStreams.set(streamId, controller);

    try {
      for await (const msg of this.handle.stream({ signal: controller.signal })) {
        if (controller.signal.aborted) break;
        send(out, {
          jsonrpc: "2.0",
          method: NOTIF_STREAM_MESSAGE,
          params: {
            sessionId: this.ctx.sessionId,
            streamId,
            message: msg as Record<string, unknown>,
          },
        });
      }
      send(out, {
        jsonrpc: "2.0",
        method: NOTIF_STREAM_END,
        params: {
          sessionId: this.ctx.sessionId,
          streamId,
          reason: controller.signal.aborted ? "cancelled" : "message_stop",
        },
      });
    } catch (err) {
      send(out, {
        jsonrpc: "2.0",
        method: NOTIF_STREAM_ERROR,
        params: {
          sessionId: this.ctx.sessionId,
          streamId,
          error: { code: -32003, message: (err as Error).message },
        },
      });
    } finally {
      this.activeStreams.delete(streamId);
    }
  }

  cancelStream(streamId: string): void {
    this.activeStreams.get(streamId)?.abort();
  }

  async close(): Promise<void> {
    if (typeof this.handle?.close === "function") {
      try {
        await this.handle.close();
      } catch {
        /* swallow — closing a dead handle is fine */
      }
    }
    this.closed = true;
  }

  async resume(options?: Record<string, unknown>): Promise<void> {
    if (!this.sdk.unstable_v2_resumeSession) {
      throw new Error("installed SDK has no unstable_v2_resumeSession");
    }
    this.handle = await this.sdk.unstable_v2_resumeSession(this.ctx.sessionId, options);
    this.closed = false;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface ModeInfo {
  mode: "mock" | "real";
  sdkVersion: string;
  reason?: string;
}

export async function buildSession(): Promise<{ make: () => SessionEnvelope; info: ModeInfo }> {
  const forcedMock = process.env.SIDECAR_MOCK === "1";

  if (forcedMock) {
    return {
      make: () => new MockSession(),
      info: { mode: "mock", sdkVersion: "mock-0.1.0", reason: "SIDECAR_MOCK=1" },
    };
  }

  try {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkModule;
    const version = await readSdkVersion();
    return {
      make: () => new RealSession(mod),
      info: { mode: "real", sdkVersion: version },
    };
  } catch (err) {
    return {
      make: () => new MockSession(),
      info: {
        mode: "mock",
        sdkVersion: "mock-0.1.0",
        reason: `SDK import failed: ${(err as Error).message}`,
      },
    };
  }
}

async function readSdkVersion(): Promise<string> {
  try {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkg = require("@anthropic-ai/claude-agent-sdk/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function chunkString(s: string, n: number): string[] {
  if (n <= 0) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [""];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
