/**
 * Per-session wrapper around the TS Agent SDK.
 *
 * One `unstable_v2_createSession` handle per logical Elixir session. The
 * Elixir-generated `sessionId` is the demux key on the wire — it is NOT
 * passed to the SDK (the SDK generates its own). We retain the SDK's
 * sessionId in `sdkSessionId` in case a caller needs it (e.g. resume).
 */
import { createRequire } from "node:module";
import { send } from "./framing.js";
import { NOTIF_STREAM_END, NOTIF_STREAM_ERROR, NOTIF_STREAM_MESSAGE, } from "./protocol.js";
export class RealSession {
    sdk;
    _rpc;
    handle;
    sessionId;
    sdkSessionId = null;
    createdAt;
    options = {};
    closed = false;
    cancelled = new Set();
    constructor(sdk, _rpc) {
        this.sdk = sdk;
        this._rpc = _rpc;
    }
    async create(params) {
        this.sessionId = params.sessionId;
        this.options = params.options ?? {};
        this.handle = this.sdk.unstable_v2_createSession(this.options);
        this.createdAt = new Date().toISOString();
        return { sessionId: params.sessionId, createdAt: this.createdAt };
    }
    async send(message) {
        if (this.closed)
            throw new Error("session closed");
        const text = typeof message.content === "string"
            ? message.content
            : JSON.stringify(message);
        await this.handle.send(text);
    }
    async stream(streamId, out) {
        if (this.closed)
            throw new Error("session closed");
        try {
            for await (const msg of this.handle.stream()) {
                if (this.cancelled.has(streamId))
                    break;
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
        }
        catch (err) {
            send(out, {
                jsonrpc: "2.0",
                method: NOTIF_STREAM_ERROR,
                params: {
                    sessionId: this.sessionId,
                    streamId,
                    error: { code: -32003, message: err.message },
                },
            });
        }
    }
    cancelStream(streamId) {
        this.cancelled.add(streamId);
    }
    async close() {
        if (!this.closed) {
            try {
                this.handle.close();
            }
            catch {
                /* closing a dead handle is fine */
            }
            this.closed = true;
        }
    }
    async resume(options = {}) {
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
    captureSdkSessionId(msg) {
        if (this.sdkSessionId)
            return;
        const id = msg.session_id;
        if (typeof id === "string")
            this.sdkSessionId = id;
    }
}
export async function buildSession() {
    const mod = (await import("@anthropic-ai/claude-agent-sdk"));
    if (typeof mod.unstable_v2_createSession !== "function") {
        throw new Error("installed @anthropic-ai/claude-agent-sdk does not expose unstable_v2_createSession");
    }
    const version = readSdkVersion();
    return {
        make: (rpc) => new RealSession(mod, rpc),
        info: { sdkVersion: version },
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