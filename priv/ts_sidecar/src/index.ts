#!/usr/bin/env node
/**
 * Sidecar main loop.
 *
 * One Node process, many logical sessions. Reads JSON-RPC frames from
 * stdin, dispatches requests by method, routes responses to the
 * outbound RPC client, writes notifications and responses to stdout.
 * Every session operation carries a `sessionId` — the Elixir side
 * owns that identifier; the sidecar stores session handles in
 * `sessions: Map<sessionId, SessionEnvelope>`.
 */

import { readFrames, send } from "./framing.js";
import { buildSession, type SessionEnvelope } from "./session.js";
import { OutboundRpc } from "./rpc.js";
import {
  ERROR_INTERNAL,
  ERROR_INVALID_PARAMS,
  ERROR_METHOD_NOT_FOUND,
  ERROR_SESSION_UNKNOWN,
  METHOD_PING,
  METHOD_SESSION_CLOSE,
  METHOD_SESSION_CREATE,
  METHOD_SESSION_RESUME,
  METHOD_SESSION_SEND,
  METHOD_SESSION_STREAM_CANCEL,
  METHOD_SESSION_STREAM_START,
  METHOD_SHUTDOWN,
  NOTIF_LOG,
  NOTIF_SIDECAR_READY,
  PROTOCOL_VERSION,
  type SessionCloseParams,
  type SessionCreateParams,
  type SessionResumeParams,
  type SessionSendParams,
  type SessionStreamCancelParams,
  type SessionStreamStartParams,
} from "./protocol.js";

const SIDECAR_VERSION = "0.1.0";

async function main(): Promise<void> {
  const { make, info } = await buildSession();
  const rpc = new OutboundRpc(process.stdout);
  const sessions = new Map<string, SessionEnvelope>();

  send(process.stdout, {
    jsonrpc: "2.0",
    method: NOTIF_SIDECAR_READY,
    params: {
      protocolVersion: PROTOCOL_VERSION,
      sidecarVersion: SIDECAR_VERSION,
      sdkVersion: info.sdkVersion,
      nodeVersion: process.versions.node,
      mode: info.mode,
      modeReason: info.reason ?? null,
    },
  });

  log("info", `sidecar ready (${info.mode})${info.reason ? ` — ${info.reason}` : ""}`);

  let shuttingDown = false;

  for await (const frame of readFrames(process.stdin)) {
    const v = frame.value as Record<string, unknown>;

    // Responses to our own outbound calls (hook.fire, mcp.call) are
    // absorbed here and never hit the dispatcher.
    if (rpc.feed(v)) continue;

    const isRequest = typeof v.id !== "undefined" && typeof v.method === "string";
    if (!isRequest) continue;

    const id = v.id as number | string;
    const method = v.method as string;
    const params = (v.params ?? {}) as Record<string, unknown>;

    // Dispatch the request in a fresh microtask so long-running calls
    // (e.g. session.create under a slow resume) don't block the reader.
    void handleRequest(id, method, params, { sessions, make, rpc, log }).then((shouldShutdown) => {
      if (shouldShutdown) shuttingDown = true;
    });

    if (shuttingDown) break;
  }

  for (const [, env] of sessions) {
    try {
      await env.close();
    } catch {
      /* ignore */
    }
  }
  rpc.drain("sidecar shutting down");

  if (shuttingDown) {
    process.exit(0);
  }
}

interface DispatchCtx {
  sessions: Map<string, SessionEnvelope>;
  make: (rpc: OutboundRpc) => SessionEnvelope;
  rpc: OutboundRpc;
  log: (level: string, message: string, extra?: Record<string, unknown>) => void;
}

async function handleRequest(
  id: number | string,
  method: string,
  params: Record<string, unknown>,
  ctx: DispatchCtx,
): Promise<boolean> {
  try {
    const result = await dispatch(method, params, ctx);
    send(process.stdout, { jsonrpc: "2.0", id, result });
    return method === METHOD_SHUTDOWN;
  } catch (err) {
    const e = err as { code?: number; message?: string; data?: unknown };
    send(process.stdout, {
      jsonrpc: "2.0",
      id,
      error: {
        code: typeof e.code === "number" ? e.code : ERROR_INTERNAL,
        message: e.message ?? String(err),
        data: e.data,
      },
    });
    return false;
  }
}

async function dispatch(
  method: string,
  params: Record<string, unknown>,
  ctx: DispatchCtx,
): Promise<unknown> {
  switch (method) {
    case METHOD_PING:
      return { pong: true, serverTime: new Date().toISOString() };

    case METHOD_SHUTDOWN:
      return { shuttingDown: true };

    case METHOD_SESSION_CREATE: {
      const p = params as unknown as SessionCreateParams;
      requireSessionId(p);
      if (ctx.sessions.has(p.sessionId)) {
        throw rpcError(ERROR_INVALID_PARAMS, "sessionId already exists", {
          sessionId: p.sessionId,
        });
      }
      const env = ctx.make(ctx.rpc);
      const result = await env.create(p);
      ctx.sessions.set(p.sessionId, env);
      ctx.log("info", "session created", { sessionId: p.sessionId });
      return result;
    }

    case METHOD_SESSION_SEND: {
      const p = params as unknown as SessionSendParams;
      const env = lookup(ctx, p.sessionId);
      await env.send(p.message);
      return { accepted: true };
    }

    case METHOD_SESSION_STREAM_START: {
      const p = params as unknown as SessionStreamStartParams;
      const env = lookup(ctx, p.sessionId);
      env.stream(p.streamId, process.stdout).catch((err) => {
        ctx.log("error", "stream failed", {
          sessionId: p.sessionId,
          streamId: p.streamId,
          error: (err as Error).message,
        });
      });
      return { streamId: p.streamId };
    }

    case METHOD_SESSION_STREAM_CANCEL: {
      const p = params as unknown as SessionStreamCancelParams;
      const env = lookup(ctx, p.sessionId);
      env.cancelStream(p.streamId);
      return { cancelled: true };
    }

    case METHOD_SESSION_CLOSE: {
      const p = params as unknown as SessionCloseParams;
      const env = lookup(ctx, p.sessionId);
      await env.close();
      ctx.sessions.delete(p.sessionId);
      ctx.log("info", "session closed", { sessionId: p.sessionId });
      return { closed: true };
    }

    case METHOD_SESSION_RESUME: {
      const p = params as unknown as SessionResumeParams;
      const env = lookup(ctx, p.sessionId);
      await env.resume(p.options);
      return { sessionId: p.sessionId, resumedAt: new Date().toISOString() };
    }

    default:
      throw rpcError(ERROR_METHOD_NOT_FOUND, `unknown method: ${method}`);
  }
}

function requireSessionId(p: { sessionId?: string }): asserts p is { sessionId: string } {
  if (!p.sessionId || typeof p.sessionId !== "string") {
    throw rpcError(ERROR_INVALID_PARAMS, "sessionId required");
  }
}

function lookup(ctx: DispatchCtx, sessionId: string): SessionEnvelope {
  const env = ctx.sessions.get(sessionId);
  if (!env) {
    throw rpcError(ERROR_SESSION_UNKNOWN, `no session: ${sessionId}`, { sessionId });
  }
  return env;
}

function rpcError(code: number, message: string, data?: unknown): Error & {
  code: number;
  data?: unknown;
} {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  err.data = data;
  return err;
}

function log(level: string, message: string, fields?: Record<string, unknown>): void {
  send(process.stdout, {
    jsonrpc: "2.0",
    method: NOTIF_LOG,
    params: { level, message, fields },
  });
}

main().catch((err) => {
  process.stderr.write(`sidecar crashed: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
