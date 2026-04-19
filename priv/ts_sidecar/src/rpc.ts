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
import { send } from "./framing.js";

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
};

export interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(payload: RpcErrorPayload) {
    super(payload.message);
    this.code = payload.code;
    this.data = payload.data;
  }
}

export class OutboundRpc {
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor(
    private out: Writable,
    private defaultTimeoutMs = 30_000,
  ) {}

  /**
   * Issue a request. Resolves with `result` on success, rejects with
   * `RpcError` on JSON-RPC error, rejects with Error on timeout.
   */
  call<R = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<R> {
    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;

    const promise = new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`outbound RPC ${method} timed out after ${effectiveTimeout}ms`));
        }
      }, effectiveTimeout);

      this.pending.set(id, {
        resolve: (v) => resolve(v as R),
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
  feed(frame: Record<string, unknown>): boolean {
    const hasId = typeof frame.id !== "undefined";
    const hasResult = Object.prototype.hasOwnProperty.call(frame, "result");
    const hasError = Object.prototype.hasOwnProperty.call(frame, "error");

    if (!hasId || !(hasResult || hasError)) return false;

    const id = Number(frame.id);
    const pending = this.pending.get(id);
    if (!pending) return false;

    clearTimeout(pending.timer);
    this.pending.delete(id);

    if (hasError) {
      pending.reject(new RpcError(frame.error as RpcErrorPayload));
    } else {
      pending.resolve(frame.result);
    }
    return true;
  }

  /** Reject every outstanding promise — used on shutdown. */
  drain(reason: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
