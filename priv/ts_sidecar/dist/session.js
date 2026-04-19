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
import { send } from "./framing.js";
import { NOTIF_STREAM_END, NOTIF_STREAM_ERROR, NOTIF_STREAM_MESSAGE, } from "./protocol.js";
// ---------------------------------------------------------------------------
// Mock session — deterministic echo, no network
// ---------------------------------------------------------------------------
export class MockSession {
    ctx;
    createdAt;
    lastUserText = "";
    cancelled = new Set();
    closed = false;
    async create(params) {
        this.ctx = {
            sessionId: params.sessionId,
            hookEvents: params.hookEvents ?? [],
            mcpTools: params.mcpTools ?? [],
            options: params.options ?? {},
        };
        this.createdAt = new Date().toISOString();
        return { sessionId: params.sessionId, createdAt: this.createdAt };
    }
    async send(message) {
        if (this.closed)
            throw new Error("session closed");
        const content = typeof message.content === "string" ? message.content : "";
        this.lastUserText = content;
    }
    async stream(streamId, out) {
        if (this.closed)
            throw new Error("session closed");
        const reply = `echo (mock): ${this.lastUserText}`;
        const chunks = chunkString(reply, 16);
        for (const chunk of chunks) {
            if (this.cancelled.has(streamId))
                break;
            send(out, {
                jsonrpc: "2.0",
                method: NOTIF_STREAM_MESSAGE,
                params: {
                    sessionId: this.ctx.sessionId,
                    streamId,
                    message: { type: "text_delta", text: chunk },
                },
            });
            await sleep(5);
        }
        send(out, {
            jsonrpc: "2.0",
            method: NOTIF_STREAM_END,
            params: {
                sessionId: this.ctx.sessionId,
                streamId,
                reason: this.cancelled.has(streamId) ? "cancelled" : "message_stop",
            },
        });
    }
    cancelStream(streamId) {
        this.cancelled.add(streamId);
    }
    async close() {
        this.closed = true;
    }
    async resume(_options) {
        this.closed = false;
    }
}
export class RealSession {
    sdk;
    handle;
    ctx;
    createdAt;
    closed = false;
    activeStreams = new Map();
    constructor(sdk) {
        this.sdk = sdk;
    }
    async create(params) {
        if (!this.sdk.unstable_v2_createSession) {
            throw new Error("installed @anthropic-ai/claude-agent-sdk does not expose unstable_v2_createSession");
        }
        this.ctx = {
            sessionId: params.sessionId,
            hookEvents: params.hookEvents ?? [],
            mcpTools: params.mcpTools ?? [],
            options: params.options ?? {},
        };
        this.handle = await this.sdk.unstable_v2_createSession({
            ...params.options,
            sessionId: params.sessionId,
        });
        this.createdAt = new Date().toISOString();
        return { sessionId: params.sessionId, createdAt: this.createdAt };
    }
    async send(message) {
        if (this.closed)
            throw new Error("session closed");
        if (typeof this.handle?.send !== "function") {
            throw new Error("session handle has no send()");
        }
        await this.handle.send(message);
    }
    async stream(streamId, out) {
        if (this.closed)
            throw new Error("session closed");
        if (typeof this.handle?.stream !== "function") {
            throw new Error("session handle has no stream()");
        }
        const controller = new AbortController();
        this.activeStreams.set(streamId, controller);
        try {
            for await (const msg of this.handle.stream({ signal: controller.signal })) {
                if (controller.signal.aborted)
                    break;
                send(out, {
                    jsonrpc: "2.0",
                    method: NOTIF_STREAM_MESSAGE,
                    params: {
                        sessionId: this.ctx.sessionId,
                        streamId,
                        message: msg,
                    },
                });
            }
            send(out, {
                jsonrpc: "2.0",
                method: NOTIF_STREAM_END,
                params: {
                    sessionId: this.ctx.sessionId,
                    streamId,
                    reason: controller.signal.aborted ? "cancelled" : "message_stop",
                },
            });
        }
        catch (err) {
            send(out, {
                jsonrpc: "2.0",
                method: NOTIF_STREAM_ERROR,
                params: {
                    sessionId: this.ctx.sessionId,
                    streamId,
                    error: { code: -32003, message: err.message },
                },
            });
        }
        finally {
            this.activeStreams.delete(streamId);
        }
    }
    cancelStream(streamId) {
        this.activeStreams.get(streamId)?.abort();
    }
    async close() {
        if (typeof this.handle?.close === "function") {
            try {
                await this.handle.close();
            }
            catch {
                /* swallow — closing a dead handle is fine */
            }
        }
        this.closed = true;
    }
    async resume(options) {
        if (!this.sdk.unstable_v2_resumeSession) {
            throw new Error("installed SDK has no unstable_v2_resumeSession");
        }
        this.handle = await this.sdk.unstable_v2_resumeSession(this.ctx.sessionId, options);
        this.closed = false;
    }
}
export async function buildSession() {
    const forcedMock = process.env.SIDECAR_MOCK === "1";
    if (forcedMock) {
        return {
            make: () => new MockSession(),
            info: { mode: "mock", sdkVersion: "mock-0.1.0", reason: "SIDECAR_MOCK=1" },
        };
    }
    try {
        const mod = (await import("@anthropic-ai/claude-agent-sdk"));
        const version = await readSdkVersion();
        return {
            make: () => new RealSession(mod),
            info: { mode: "real", sdkVersion: version },
        };
    }
    catch (err) {
        return {
            make: () => new MockSession(),
            info: {
                mode: "mock",
                sdkVersion: "mock-0.1.0",
                reason: `SDK import failed: ${err.message}`,
            },
        };
    }
}
async function readSdkVersion() {
    try {
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const pkg = require("@anthropic-ai/claude-agent-sdk/package.json");
        return pkg.version ?? "unknown";
    }
    catch {
        return "unknown";
    }
}
function chunkString(s, n) {
    if (n <= 0)
        return [s];
    const out = [];
    for (let i = 0; i < s.length; i += n)
        out.push(s.slice(i, i + n));
    return out.length ? out : [""];
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
//# sourceMappingURL=session.js.map