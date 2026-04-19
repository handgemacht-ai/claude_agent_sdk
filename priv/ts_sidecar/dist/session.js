/**
 * Sidecar session built on the stable `query()` API.
 *
 * Design:
 *   • One `query()` per logical Elixir session. Streaming input enables
 *     multi-turn conversations and unlocks the full `Query` control
 *     surface (getContextUsage, supportedAgents, setModel, etc.).
 *   • A pushable async iterable feeds user messages into the query.
 *   • Every SDK message is forwarded verbatim as `session.message`.
 *   • Control methods are routed through `CONTROL_METHODS` — any
 *     method listed here can be invoked via `session.control` RPC.
 */
import { createRequire } from "node:module";
import { send } from "./framing.js";
import { NOTIF_SESSION_CLOSED, NOTIF_SESSION_ERROR, NOTIF_SESSION_MESSAGE, METHOD_CAN_USE_TOOL, } from "./protocol.js";
export const CONTROL_METHODS = [
    "interrupt",
    "setPermissionMode",
    "setModel",
    "applyFlagSettings",
    "initializationResult",
    "supportedCommands",
    "supportedModels",
    "supportedAgents",
    "mcpServerStatus",
    "getContextUsage",
    "reloadPlugins",
    "accountInfo",
    "rewindFiles",
    "seedReadState",
    "reconnectMcpServer",
    "toggleMcpServer",
    "setMcpServers",
    "stopTask",
];
function isControlMethod(name) {
    return CONTROL_METHODS.includes(name);
}
function makeInputChannel() {
    const queue = [];
    const resolvers = [];
    let closed = false;
    const iterable = {
        [Symbol.asyncIterator]() {
            return {
                next() {
                    if (queue.length > 0) {
                        return Promise.resolve({ value: queue.shift(), done: false });
                    }
                    if (closed)
                        return Promise.resolve({ value: undefined, done: true });
                    return new Promise((resolve) => resolvers.push(resolve));
                },
                return() {
                    closed = true;
                    while (resolvers.length)
                        resolvers.shift()({ value: undefined, done: true });
                    return Promise.resolve({ value: undefined, done: true });
                },
            };
        },
    };
    return {
        iterable,
        push(msg) {
            if (closed)
                throw new Error("input channel closed");
            const r = resolvers.shift();
            if (r)
                r({ value: msg, done: false });
            else
                queue.push(msg);
        },
        close() {
            closed = true;
            while (resolvers.length)
                resolvers.shift()({ value: undefined, done: true });
        },
    };
}
export class QuerySession {
    sdk;
    rpc;
    out;
    query;
    input;
    sessionId;
    createdAt;
    closed = false;
    pumpDone;
    turnSeq = 0;
    constructor(sdk, rpc, out) {
        this.sdk = sdk;
        this.rpc = rpc;
        this.out = out;
    }
    async create(params) {
        this.sessionId = params.sessionId;
        this.input = makeInputChannel();
        const options = this.enrichOptions(params.options, params.permissionBridge ?? false);
        this.query = this.sdk.query({ prompt: this.input.iterable, options });
        this.createdAt = new Date().toISOString();
        this.pumpDone = this.pump();
        return { sessionId: this.sessionId, createdAt: this.createdAt };
    }
    async send(content, turnId) {
        if (this.closed)
            throw new Error("session closed");
        const assigned = turnId ?? this.nextTurnId();
        this.input.push({
            type: "user",
            message: { role: "user", content },
            parent_tool_use_id: null,
        });
        return assigned;
    }
    async control(method, args) {
        if (this.closed)
            throw new Error("session closed");
        if (!isControlMethod(method)) {
            throw new Error(`unknown control method: ${method}`);
        }
        const handle = this.query;
        const fn = handle[method];
        if (typeof fn !== "function") {
            throw new Error(`Query does not expose ${method}`);
        }
        return await fn.apply(this.query, args ?? []);
    }
    async resume(sdkSessionId, options) {
        this.input.close();
        try {
            this.query.close();
        }
        catch {
            /* fine */
        }
        this.input = makeInputChannel();
        const merged = { ...options, resume: sdkSessionId };
        const enriched = this.enrichOptions(merged, false);
        this.query = this.sdk.query({ prompt: this.input.iterable, options: enriched });
        this.closed = false;
        this.pumpDone = this.pump();
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        this.input.close();
        try {
            this.query.close();
        }
        catch {
            /* fine */
        }
        try {
            await this.pumpDone;
        }
        catch {
            /* pump resolves on close */
        }
    }
    nextTurnId() {
        this.turnSeq += 1;
        return `turn-${this.turnSeq}`;
    }
    async pump() {
        try {
            for await (const msg of this.query) {
                if (this.closed)
                    break;
                send(this.out, {
                    jsonrpc: "2.0",
                    method: NOTIF_SESSION_MESSAGE,
                    params: { sessionId: this.sessionId, message: msg },
                });
            }
            if (!this.closed) {
                send(this.out, {
                    jsonrpc: "2.0",
                    method: NOTIF_SESSION_CLOSED,
                    params: { sessionId: this.sessionId, reason: "iterator_done" },
                });
                this.closed = true;
            }
        }
        catch (err) {
            send(this.out, {
                jsonrpc: "2.0",
                method: NOTIF_SESSION_ERROR,
                params: {
                    sessionId: this.sessionId,
                    error: { code: -32010, message: err.message },
                },
            });
        }
    }
    /**
     * Inject a canUseTool proxy that forwards decisions back to Elixir, if the
     * caller opted in. We intentionally do not mutate the caller's hooks/options
     * further — everything else is passed through as the SDK expects.
     */
    enrichOptions(options, permissionBridge) {
        if (!permissionBridge)
            return options;
        const canUseTool = async (toolName, input) => {
            const res = await this.rpc.call(METHOD_CAN_USE_TOOL, {
                sessionId: this.sessionId,
                toolName,
                input,
            });
            return res;
        };
        return { ...options, canUseTool };
    }
}
export async function buildSession() {
    const mod = (await import("@anthropic-ai/claude-agent-sdk"));
    if (typeof mod.query !== "function") {
        throw new Error("installed @anthropic-ai/claude-agent-sdk does not export query()");
    }
    return {
        make: (rpc, out) => new QuerySession(mod, rpc, out),
        info: { sdkVersion: readSdkVersion() },
    };
}
function readSdkVersion() {
    try {
        const require = createRequire(import.meta.url);
        const pkg = require("@anthropic-ai/claude-agent-sdk/package.json");
        return pkg.version ?? "unknown";
    }
    catch {
        return "unknown";
    }
}
//# sourceMappingURL=session.js.map