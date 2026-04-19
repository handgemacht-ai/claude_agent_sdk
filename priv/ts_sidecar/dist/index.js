#!/usr/bin/env node
/**
 * Sidecar main loop.
 *
 * One Node process, many logical sessions. Each session wraps a single
 * `query()` on the SDK. Control operations (getContextUsage,
 * supportedAgents, setModel, interrupt, …) route through
 * `session.control`.
 */
import { readFrames, send } from "./framing.js";
import { buildSession } from "./session.js";
import { OutboundRpc } from "./rpc.js";
import { ERROR_CONTROL_FAILED, ERROR_INTERNAL, ERROR_INVALID_PARAMS, ERROR_METHOD_NOT_FOUND, ERROR_SESSION_UNKNOWN, METHOD_PING, METHOD_SESSION_CLOSE, METHOD_SESSION_CONTROL, METHOD_SESSION_CREATE, METHOD_SESSION_RESUME, METHOD_SESSION_SEND, METHOD_SHUTDOWN, NOTIF_LOG, NOTIF_SIDECAR_READY, PROTOCOL_VERSION, } from "./protocol.js";
const SIDECAR_VERSION = "0.2.0";
async function main() {
    const { make, info } = await buildSession();
    const rpc = new OutboundRpc(process.stdout);
    const sessions = new Map();
    send(process.stdout, {
        jsonrpc: "2.0",
        method: NOTIF_SIDECAR_READY,
        params: {
            protocolVersion: PROTOCOL_VERSION,
            sidecarVersion: SIDECAR_VERSION,
            sdkVersion: info.sdkVersion,
            nodeVersion: process.versions.node,
        },
    });
    log("info", `sidecar ready (sdk ${info.sdkVersion})`);
    let shuttingDown = false;
    for await (const frame of readFrames(process.stdin)) {
        const v = frame.value;
        // Responses to outbound RPCs (hook.fire, mcp.call, can_use_tool) are
        // absorbed here and never hit the dispatcher.
        if (rpc.feed(v))
            continue;
        const isRequest = typeof v.id !== "undefined" && typeof v.method === "string";
        if (!isRequest)
            continue;
        const id = v.id;
        const method = v.method;
        const params = (v.params ?? {});
        void handleRequest(id, method, params, { sessions, make, rpc, log }).then((shouldShutdown) => {
            if (shouldShutdown)
                shuttingDown = true;
        });
        if (shuttingDown)
            break;
    }
    for (const [, env] of sessions) {
        try {
            await env.close();
        }
        catch {
            /* ignore */
        }
    }
    rpc.drain("sidecar shutting down");
    if (shuttingDown) {
        process.exit(0);
    }
}
async function handleRequest(id, method, params, ctx) {
    try {
        const result = await dispatch(method, params, ctx);
        send(process.stdout, { jsonrpc: "2.0", id, result });
        return method === METHOD_SHUTDOWN;
    }
    catch (err) {
        const e = err;
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
async function dispatch(method, params, ctx) {
    switch (method) {
        case METHOD_PING:
            return { pong: true, serverTime: new Date().toISOString() };
        case METHOD_SHUTDOWN:
            return { shuttingDown: true };
        case METHOD_SESSION_CREATE: {
            const p = params;
            requireSessionId(p);
            if (ctx.sessions.has(p.sessionId)) {
                throw rpcError(ERROR_INVALID_PARAMS, "sessionId already exists", {
                    sessionId: p.sessionId,
                });
            }
            const env = ctx.make(ctx.rpc, process.stdout);
            const result = await env.create(p);
            ctx.sessions.set(p.sessionId, env);
            ctx.log("info", "session created", { sessionId: p.sessionId });
            return result;
        }
        case METHOD_SESSION_SEND: {
            const p = params;
            const env = lookup(ctx, p.sessionId);
            const turnId = await env.send(p.content, p.turnId);
            return { turnId };
        }
        case METHOD_SESSION_CONTROL: {
            const p = params;
            const env = lookup(ctx, p.sessionId);
            try {
                const value = await env.control(p.method, p.args);
                return { value };
            }
            catch (err) {
                throw rpcError(ERROR_CONTROL_FAILED, err.message, {
                    sessionId: p.sessionId,
                    method: p.method,
                });
            }
        }
        case METHOD_SESSION_RESUME: {
            const p = params;
            const env = lookup(ctx, p.sessionId);
            await env.resume(p.sdkSessionId, p.options ?? {});
            return { sessionId: p.sessionId, resumedAt: new Date().toISOString() };
        }
        case METHOD_SESSION_CLOSE: {
            const p = params;
            const env = lookup(ctx, p.sessionId);
            await env.close();
            ctx.sessions.delete(p.sessionId);
            ctx.log("info", "session closed", { sessionId: p.sessionId });
            return { closed: true };
        }
        default:
            throw rpcError(ERROR_METHOD_NOT_FOUND, `unknown method: ${method}`);
    }
}
function requireSessionId(p) {
    if (!p.sessionId || typeof p.sessionId !== "string") {
        throw rpcError(ERROR_INVALID_PARAMS, "sessionId required");
    }
}
function lookup(ctx, sessionId) {
    const env = ctx.sessions.get(sessionId);
    if (!env) {
        throw rpcError(ERROR_SESSION_UNKNOWN, `no session: ${sessionId}`, { sessionId });
    }
    return env;
}
function rpcError(code, message, data) {
    const err = new Error(message);
    err.code = code;
    err.data = data;
    return err;
}
function log(level, message, fields) {
    send(process.stdout, {
        jsonrpc: "2.0",
        method: NOTIF_LOG,
        params: { level, message, fields },
    });
}
main().catch((err) => {
    process.stderr.write(`sidecar crashed: ${err.stack ?? err}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map