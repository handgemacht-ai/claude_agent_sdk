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
import { send } from "./framing.js";
export class RpcError extends Error {
    code;
    data;
    constructor(payload) {
        super(payload.message);
        this.code = payload.code;
        this.data = payload.data;
    }
}
export class OutboundRpc {
    out;
    defaultTimeoutMs;
    nextId = 1;
    pending = new Map();
    constructor(out, defaultTimeoutMs = 30_000) {
        this.out = out;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }
    /**
     * Issue a request. Resolves with `result` on success, rejects with
     * `RpcError` on JSON-RPC error, rejects with Error on timeout.
     */
    call(method, params, timeoutMs) {
        const id = this.nextId++;
        const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    reject(new Error(`outbound RPC ${method} timed out after ${effectiveTimeout}ms`));
                }
            }, effectiveTimeout);
            this.pending.set(id, {
                resolve: (v) => resolve(v),
                reject,
                timer,
            });
        });
        send(this.out, { jsonrpc: "2.0", id, method, params });
        return promise;
    }
    /**
     * Hand a decoded frame to the client. Returns `true` if the frame
     * was a response to one of our outstanding requests, `false` if it
     * should be dispatched as an inbound request/notification instead.
     */
    feed(frame) {
        const hasId = typeof frame.id !== "undefined";
        const hasResult = Object.prototype.hasOwnProperty.call(frame, "result");
        const hasError = Object.prototype.hasOwnProperty.call(frame, "error");
        if (!hasId || !(hasResult || hasError))
            return false;
        const id = Number(frame.id);
        const pending = this.pending.get(id);
        if (!pending)
            return false;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (hasError) {
            pending.reject(new RpcError(frame.error));
        }
        else {
            pending.resolve(frame.result);
        }
        return true;
    }
    /** Reject every outstanding promise — used on shutdown. */
    drain(reason) {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error(reason));
        }
        this.pending.clear();
    }
}
//# sourceMappingURL=rpc.js.map