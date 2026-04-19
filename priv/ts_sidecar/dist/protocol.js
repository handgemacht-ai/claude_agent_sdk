/**
 * Single source of truth for the Elixir ↔ Node sidecar wire protocol.
 *
 * Mirrors `lib/claude_agent_sdk/json_rpc/protocol.ex` exactly. Every
 * method name, notification name, and payload shape in this file has a
 * counterpart in the Elixir module, and vice versa. A parity test on
 * the Elixir side enforces this at CI time.
 *
 * Framing: newline-delimited JSON-RPC 2.0 over stdio. One JSON object
 * per `\n` terminated line. Stdout carries JSON-RPC frames only.
 * Stderr is unstructured human log output and must never be parsed.
 *
 * Every `session.*` method and every session-scoped notification
 * carries a `sessionId`. The Elixir side generates the sessionId (UUID
 * v4) and passes it into `session.create`; the sidecar stores the
 * upstream `unstable_v2_createSession` handle keyed by it.
 */
// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------
export const PROTOCOL_VERSION = "1.0";
// ---------------------------------------------------------------------------
// Methods — Elixir → Node (request/response)
// ---------------------------------------------------------------------------
export const METHOD_SESSION_CREATE = "session.create";
export const METHOD_SESSION_SEND = "session.send";
export const METHOD_SESSION_STREAM_START = "session.stream.start";
export const METHOD_SESSION_STREAM_CANCEL = "session.stream.cancel";
export const METHOD_SESSION_RESUME = "session.resume";
export const METHOD_SESSION_CLOSE = "session.close";
export const METHOD_PING = "ping";
export const METHOD_SHUTDOWN = "shutdown";
// ---------------------------------------------------------------------------
// Methods — Node → Elixir (request/response)
// ---------------------------------------------------------------------------
export const METHOD_HOOK_FIRE = "hook.fire";
export const METHOD_MCP_CALL = "mcp.call";
// ---------------------------------------------------------------------------
// Notifications (no id, no response)
// ---------------------------------------------------------------------------
export const NOTIF_SIDECAR_READY = "sidecar.ready";
export const NOTIF_STREAM_MESSAGE = "stream.message";
export const NOTIF_STREAM_END = "stream.end";
export const NOTIF_STREAM_ERROR = "stream.error";
export const NOTIF_LOG = "log";
// ---------------------------------------------------------------------------
// Aggregate const arrays (keep parity checker happy on both sides)
// ---------------------------------------------------------------------------
export const METHODS = [
    METHOD_SESSION_CREATE,
    METHOD_SESSION_SEND,
    METHOD_SESSION_STREAM_START,
    METHOD_SESSION_STREAM_CANCEL,
    METHOD_SESSION_RESUME,
    METHOD_SESSION_CLOSE,
    METHOD_PING,
    METHOD_SHUTDOWN,
    METHOD_HOOK_FIRE,
    METHOD_MCP_CALL,
];
export const NOTIFICATIONS = [
    NOTIF_SIDECAR_READY,
    NOTIF_STREAM_MESSAGE,
    NOTIF_STREAM_END,
    NOTIF_STREAM_ERROR,
    NOTIF_LOG,
];
// ---------------------------------------------------------------------------
// Error codes (JSON-RPC 2.0 reserves −32768..−32000)
// ---------------------------------------------------------------------------
export const ERROR_PARSE = -32700;
export const ERROR_INVALID_REQUEST = -32600;
export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;
export const ERROR_SESSION_UNKNOWN = -32001;
export const ERROR_SESSION_CLOSED = -32002;
export const ERROR_STREAM_CANCELLED = -32003;
export const ERROR_HOOK_FAILED = -32004;
export const ERROR_MCP_FAILED = -32005;
export const ERROR_SIDECAR_SHUTTING_DOWN = -32006;
//# sourceMappingURL=protocol.js.map