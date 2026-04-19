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
import { OutboundRpc } from "./rpc.js";
import { type McpToolDescriptor, type SessionCreateParams, type SessionCreateResult } from "./protocol.js";
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
export declare class MockSession implements SessionEnvelope {
    private rpc;
    private ctx;
    private createdAt;
    private lastUserText;
    private cancelled;
    private closed;
    constructor(rpc: OutboundRpc);
    create(params: SessionCreateParams): Promise<SessionCreateResult>;
    send(message: Record<string, unknown>): Promise<void>;
    stream(streamId: string, out: Writable): Promise<void>;
    cancelStream(streamId: string): void;
    close(): Promise<void>;
    resume(_options?: Record<string, unknown>): Promise<void>;
    private emitStreamEnd;
    private emitStreamError;
}
type SdkModule = {
    unstable_v2_createSession?: (opts: unknown) => Promise<unknown>;
    unstable_v2_resumeSession?: (sessionId: string, opts?: unknown) => Promise<unknown>;
};
export declare class RealSession implements SessionEnvelope {
    private sdk;
    private rpc;
    private handle;
    private ctx;
    private createdAt;
    private closed;
    private activeStreams;
    constructor(sdk: SdkModule, rpc: OutboundRpc);
    create(params: SessionCreateParams): Promise<SessionCreateResult>;
    send(message: Record<string, unknown>): Promise<void>;
    stream(streamId: string, out: Writable): Promise<void>;
    cancelStream(streamId: string): void;
    close(): Promise<void>;
    resume(options?: Record<string, unknown>): Promise<void>;
}
export interface ModeInfo {
    mode: "mock" | "real";
    sdkVersion: string;
    reason?: string;
}
export declare function buildSession(): Promise<{
    make: (rpc: OutboundRpc) => SessionEnvelope;
    info: ModeInfo;
}>;
export {};
