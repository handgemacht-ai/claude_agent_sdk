/**
 * Per-session wrapper around the TS Agent SDK.
 *
 * One `unstable_v2_createSession` handle per logical Elixir session. The
 * Elixir-generated `sessionId` is the demux key on the wire — it is NOT
 * passed to the SDK (the SDK generates its own). We retain the SDK's
 * sessionId in `sdkSessionId` in case a caller needs it (e.g. resume).
 */
import type { Writable } from "node:stream";
import { OutboundRpc } from "./rpc.js";
import { type SessionCreateParams, type SessionCreateResult } from "./protocol.js";
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
export declare class RealSession implements SessionEnvelope {
    private sdk;
    private _rpc;
    private handle;
    private sessionId;
    private sdkSessionId;
    private createdAt;
    private options;
    private closed;
    private cancelled;
    constructor(sdk: SdkModule, _rpc: OutboundRpc);
    create(params: SessionCreateParams): Promise<SessionCreateResult>;
    send(message: Record<string, unknown>): Promise<void>;
    stream(streamId: string, out: Writable): Promise<void>;
    cancelStream(streamId: string): void;
    close(): Promise<void>;
    resume(options?: Record<string, unknown>): Promise<void>;
    private captureSdkSessionId;
}
export interface ModeInfo {
    sdkVersion: string;
}
export declare function buildSession(): Promise<{
    make: (rpc: OutboundRpc) => SessionEnvelope;
    info: ModeInfo;
}>;
export {};
