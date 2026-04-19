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
 *
 * Bridges:
 *   • **hook bridge** — when the Elixir side declares `hookEvents`,
 *     the sidecar fires `hook.fire` RPCs back to Elixir at the
 *     appropriate lifecycle points and applies the `decision` to the
 *     stream (for mock mode this is demonstration; real-mode hooks
 *     wire into the SDK's own callback surface).
 *   • **MCP bridge** — when `mcpTools` are declared, mock mode invokes
 *     the first tool once per stream to exercise the `mcp.call`
 *     round-trip; real mode registers a `createSdkMcpServer` whose
 *     handlers each proxy back to Elixir via `mcp.call`.
 */

import type { Writable } from "node:stream";
import { send } from "./framing.js";
import { OutboundRpc } from "./rpc.js";
import {
  NOTIF_STREAM_END,
  NOTIF_STREAM_ERROR,
  NOTIF_STREAM_MESSAGE,
  METHOD_HOOK_FIRE,
  METHOD_MCP_CALL,
  type HookFireResult,
  type McpCallResult,
  type McpToolDescriptor,
  type SessionCreateParams,
  type SessionCreateResult,
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
  mcpTools: McpToolDescriptor[];
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

  constructor(private rpc: OutboundRpc) {}

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

    // --- Pre-stream hook (if registered) --------------------------------
    let hookDecision: HookFireResult | null = null;
    if (this.ctx.hookEvents.includes("pre_tool_use")) {
      try {
        hookDecision = await this.rpc.call<HookFireResult>(METHOD_HOOK_FIRE, {
          sessionId: this.ctx.sessionId,
          event: "pre_tool_use",
          payload: { tool_name: "mock.echo", tool_input: { text: this.lastUserText } },
        });
      } catch (err) {
        this.emitStreamError(out, streamId, `hook.fire pre_tool_use failed: ${(err as Error).message}`);
      }
    }

    if (hookDecision?.decision === "deny" || hookDecision?.decision === "block") {
      send(out, {
        jsonrpc: "2.0",
        method: NOTIF_STREAM_MESSAGE,
        params: {
          sessionId: this.ctx.sessionId,
          streamId,
          message: {
            type: "text_delta",
            text: `[blocked by hook: ${hookDecision.reason ?? "no reason"}]`,
          },
        },
      });
      this.emitStreamEnd(out, streamId, "hook_denied");
      return;
    }

    // --- MCP tool invocation (if any registered) ------------------------
    let toolPrefix = "";
    if (this.ctx.mcpTools.length > 0) {
      const first = this.ctx.mcpTools[0]!;
      try {
        const result = await this.rpc.call<McpCallResult>(METHOD_MCP_CALL, {
          sessionId: this.ctx.sessionId,
          server: first.server,
          tool: first.tool,
          args: { probe: this.lastUserText.slice(0, 16) },
        });
        const firstContent = result.content?.[0] as Record<string, unknown> | undefined;
        const text =
          typeof firstContent?.text === "string"
            ? (firstContent.text as string)
            : JSON.stringify(result);
        toolPrefix = `[tool:${first.server}/${first.tool} → ${text}] `;
      } catch (err) {
        toolPrefix = `[tool:${first.server}/${first.tool} error: ${(err as Error).message}] `;
      }
    }

    const reply = `${toolPrefix}echo (mock): ${this.lastUserText}`;
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

    // --- Post-stream hook (if registered) -------------------------------
    if (this.ctx.hookEvents.includes("task_completed")) {
      try {
        await this.rpc.call<HookFireResult>(METHOD_HOOK_FIRE, {
          sessionId: this.ctx.sessionId,
          event: "task_completed",
          payload: { reply_length: reply.length, cancelled: this.cancelled.has(streamId) },
        });
      } catch (err) {
        this.emitStreamError(out, streamId, `hook.fire task_completed failed: ${(err as Error).message}`);
      }
    }

    this.emitStreamEnd(out, streamId, this.cancelled.has(streamId) ? "cancelled" : "message_stop");
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

  private emitStreamEnd(out: Writable, streamId: string, reason: string): void {
    send(out, {
      jsonrpc: "2.0",
      method: NOTIF_STREAM_END,
      params: { sessionId: this.ctx.sessionId, streamId, reason },
    });
  }

  private emitStreamError(out: Writable, streamId: string, message: string): void {
    send(out, {
      jsonrpc: "2.0",
      method: NOTIF_STREAM_ERROR,
      params: {
        sessionId: this.ctx.sessionId,
        streamId,
        error: { code: -32004, message },
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Real session — lazy-imports the SDK, falls back to mock if unavailable
// ---------------------------------------------------------------------------

type SdkModule = {
  unstable_v2_createSession?: (opts: unknown) => Promise<unknown>;
  unstable_v2_resumeSession?: (sessionId: string, opts?: unknown) => Promise<unknown>;
};

export class RealSession implements SessionEnvelope {
  private handle: any;
  private ctx!: SessionContext;
  private createdAt!: string;
  private closed = false;
  private activeStreams = new Map<string, AbortController>();

  constructor(
    private sdk: SdkModule,
    private rpc: OutboundRpc,
  ) {}

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

    // MCP bridge: stubbed in real mode — real wiring happens when a
    // production caller lands a concrete tool schema. The TS-side
    // `createSdkMcpServer` wrapping is a follow-up once we validate
    // the `unstable_v2_createSession` handle shape in production.

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

export async function buildSession(): Promise<{
  make: (rpc: OutboundRpc) => SessionEnvelope;
  info: ModeInfo;
}> {
  const forcedMock = process.env.SIDECAR_MOCK === "1";

  if (forcedMock) {
    return {
      make: (rpc) => new MockSession(rpc),
      info: { mode: "mock", sdkVersion: "mock-0.1.0", reason: "SIDECAR_MOCK=1" },
    };
  }

  try {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkModule;
    const version = await readSdkVersion();
    return {
      make: (rpc) => new RealSession(mod, rpc),
      info: { mode: "real", sdkVersion: version },
    };
  } catch (err) {
    return {
      make: (rpc) => new MockSession(rpc),
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
