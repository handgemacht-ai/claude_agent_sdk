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
import { SessionCreateParams, SessionCreateResult } from "./protocol.js";
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
export declare class MockSession implements SessionEnvelope {
    private ctx;
    private createdAt;
    private lastUserText;
    private cancelled;
    private closed;
    create(params: SessionCreateParams): Promise<SessionCreateResult>;
    send(message: Record<string, unknown>): Promise<void>;
    stream(streamId: string, out: Writable): Promise<void>;
    cancelStream(streamId: string): void;
    close(): Promise<void>;
    resume(_options?: Record<string, unknown>): Promise<void>;
}
type SdkModule = {
    unstable_v2_createSession?: (opts: unknown) => Promise<unknown>;
    unstable_v2_resumeSession?: (sessionId: string, opts?: unknown) => Promise<unknown>;
};
export declare class RealSession implements SessionEnvelope {
    private sdk;
    private handle;
    private ctx;
    private createdAt;
    private closed;
    private activeStreams;
    constructor(sdk: SdkModule);
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
    make: () => SessionEnvelope;
    info: ModeInfo;
}>;
export {};
