/**
 * Per-session wrapper around the TS Agent SDK.
 *
 * One `unstable_v2_createSession` handle per logical Elixir session. The
 * Elixir-generated `sessionId` is the demux key on the wire — it is NOT
 * passed to the SDK (the SDK generates its own). We retain the SDK's
 * sessionId in `sdkSessionId` in case a caller needs it (e.g. resume).
 */

import type { Writable } from "node:stream";
import { createRequire } from "node:module";
import { send } from "./framing.js";
import { OutboundRpc } from "./rpc.js";
import {
  NOTIF_STREAM_END,
  NOTIF_STREAM_ERROR,
  NOTIF_STREAM_MESSAGE,
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

type SdkSession = {
  readonly sessionId: string;
  send(message: string | Record<string, unknown>): Promise<void>;
  stream(): AsyncGenerator<Record<string, unknown>, void>;
  close(): void;
};

type SdkModule = {
  unstable_v2_createSession: (opts: Record<string, unknown>) => SdkSession;
  unstable_v2_resumeSession?: (sessionId: string, opts: Record<string, unknown>) => SdkSession;
};

export class RealSession implements SessionEnvelope {
  private handle!: SdkSession;
  private sessionId!: string;
  private sdkSessionId: string | null = null;
  private createdAt!: string;
  private options: Record<string, unknown> = {};
  private closed = false;
  private cancelled = new Set<string>();

  constructor(
    private sdk: SdkModule,
    private _rpc: OutboundRpc,
  ) {}

  async create(params: SessionCreateParams): Promise<SessionCreateResult> {
    this.sessionId = params.sessionId;
    this.options = params.options ?? {};
    this.handle = this.sdk.unstable_v2_createSession(this.options);
    this.createdAt = new Date().toISOString();
    return { sessionId: params.sessionId, createdAt: this.createdAt };
  }

  async send(message: Record<string, unknown>): Promise<void> {
    if (this.closed) throw new Error("session closed");
    const text =
      typeof message.content === "string"
        ? (message.content as string)
        : JSON.stringify(message);
    await this.handle.send(text);
  }

  async stream(streamId: string, out: Writable): Promise<void> {
    if (this.closed) throw new Error("session closed");
    try {
      for await (const msg of this.handle.stream()) {
        if (this.cancelled.has(streamId)) break;
        this.captureSdkSessionId(msg);
        send(out, {
          jsonrpc: "2.0",
          method: NOTIF_STREAM_MESSAGE,
          params: { sessionId: this.sessionId, streamId, message: msg },
        });
      }
      send(out, {
        jsonrpc: "2.0",
        method: NOTIF_STREAM_END,
        params: {
          sessionId: this.sessionId,
          streamId,
          reason: this.cancelled.has(streamId) ? "cancelled" : "message_stop",
        },
      });
    } catch (err) {
      send(out, {
        jsonrpc: "2.0",
        method: NOTIF_STREAM_ERROR,
        params: {
          sessionId: this.sessionId,
          streamId,
          error: { code: -32003, message: (err as Error).message },
        },
      });
    }
  }

  cancelStream(streamId: string): void {
    this.cancelled.add(streamId);
  }

  async close(): Promise<void> {
    if (!this.closed) {
      try {
        this.handle.close();
      } catch {
        /* closing a dead handle is fine */
      }
      this.closed = true;
    }
  }

  async resume(options: Record<string, unknown> = {}): Promise<void> {
    if (!this.sdk.unstable_v2_resumeSession) {
      throw new Error("installed SDK has no unstable_v2_resumeSession");
    }
    const resumeId = this.sdkSessionId;
    if (!resumeId) {
      throw new Error("no upstream sessionId captured yet — stream at least one message first");
    }
    this.handle = this.sdk.unstable_v2_resumeSession(resumeId, { ...this.options, ...options });
    this.closed = false;
  }

  private captureSdkSessionId(msg: Record<string, unknown>): void {
    if (this.sdkSessionId) return;
    const id = msg.session_id;
    if (typeof id === "string") this.sdkSessionId = id;
  }
}

export interface ModeInfo {
  sdkVersion: string;
}

export async function buildSession(): Promise<{
  make: (rpc: OutboundRpc) => SessionEnvelope;
  info: ModeInfo;
}> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkModule;
  if (typeof mod.unstable_v2_createSession !== "function") {
    throw new Error(
      "installed @anthropic-ai/claude-agent-sdk does not expose unstable_v2_createSession",
    );
  }
  const version = readSdkVersion();
  return {
    make: (rpc) => new RealSession(mod, rpc),
    info: { sdkVersion: version },
  };
}

function readSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@anthropic-ai/claude-agent-sdk/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
