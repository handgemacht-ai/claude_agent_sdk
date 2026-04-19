/**
 * Outbound RPC client — sidecar-initiated requests to Elixir.
 *
 * Both sides of the pipe can issue JSON-RPC requests. When the TS
 * sidecar fires a hook.fire or mcp.call back to Elixir, it needs:
 *   1. a monotonically-unique id
 *   2. a Promise that resolves when the matching response arrives
 *   3. timeout + abort so a dead Elixir doesn't leak promises
 *
 * The main loop hands every inbound frame that looks like a
 * {jsonrpc, id, result|error} (response) to `feed()` before dispatching
 * {jsonrpc, id, method} (request) frames through the normal handler.
 */
import type { Writable } from "node:stream";
export interface RpcErrorPayload {
    code: number;
    message: string;
    data?: unknown;
}
export declare class RpcError extends Error {
    code: number;
    data?: unknown;
    constructor(payload: RpcErrorPayload);
}
export declare class OutboundRpc {
    private out;
    private defaultTimeoutMs;
    private nextId;
    private pending;
    constructor(out: Writable, defaultTimeoutMs?: number);
    /**
     * Issue a request. Resolves with `result` on success, rejects with
     * `RpcError` on JSON-RPC error, rejects with Error on timeout.
     */
    call<R = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<R>;
    /**
     * Hand a decoded frame to the client. Returns `true` if the frame
     * was a response to one of our outstanding requests, `false` if it
     * should be dispatched as an inbound request/notification instead.
     */
    feed(frame: Record<string, unknown>): boolean;
    /** Reject every outstanding promise — used on shutdown. */
    drain(reason: string): void;
}
