/**
 * Single source of truth for the Elixir ↔ Node sidecar wire protocol.
 *
 * Mirrors `lib/claude_agent_sdk/json_rpc/protocol.ex` exactly.
 *
 * Framing: newline-delimited JSON-RPC 2.0 over stdio. One JSON object
 * per `\n` terminated line.
 *
 * Every `session.*` method and every session-scoped notification
 * carries `sessionId` — an Elixir-generated UUID that demultiplexes
 * frames. This is distinct from the SDK's internal session_id (which
 * appears inside forwarded SDKMessage payloads).
 */
export const PROTOCOL_VERSION = "2.0";
// Elixir → Node (request/response)
export const METHOD_SESSION_CREATE = "session.create";
export const METHOD_SESSION_SEND = "session.send";
export const METHOD_SESSION_CONTROL = "session.control";
export const METHOD_SESSION_RESUME = "session.resume";
export const METHOD_SESSION_CLOSE = "session.close";
export const METHOD_PING = "ping";
export const METHOD_SHUTDOWN = "shutdown";
// Node → Elixir (request/response)
export const METHOD_HOOK_FIRE = "hook.fire";
export const METHOD_MCP_CALL = "mcp.call";
export const METHOD_CAN_USE_TOOL = "can_use_tool";
// Notifications (no id, no response)
export const NOTIF_SIDECAR_READY = "sidecar.ready";
export const NOTIF_SESSION_MESSAGE = "session.message";
export const NOTIF_SESSION_ERROR = "session.error";
export const NOTIF_SESSION_CLOSED = "session.closed";
export const NOTIF_LOG = "log";
export const METHODS = [
    METHOD_SESSION_CREATE,
    METHOD_SESSION_SEND,
    METHOD_SESSION_CONTROL,
    METHOD_SESSION_RESUME,
    METHOD_SESSION_CLOSE,
    METHOD_PING,
    METHOD_SHUTDOWN,
    METHOD_HOOK_FIRE,
    METHOD_MCP_CALL,
    METHOD_CAN_USE_TOOL,
];
export const NOTIFICATIONS = [
    NOTIF_SIDECAR_READY,
    NOTIF_SESSION_MESSAGE,
    NOTIF_SESSION_ERROR,
    NOTIF_SESSION_CLOSED,
    NOTIF_LOG,
];
// Error codes
export const ERROR_PARSE = -32700;
export const ERROR_INVALID_REQUEST = -32600;
export const ERROR_METHOD_NOT_FOUND = -32601;
export const ERROR_INVALID_PARAMS = -32602;
export const ERROR_INTERNAL = -32603;
export const ERROR_SESSION_UNKNOWN = -32001;
export const ERROR_SESSION_CLOSED = -32002;
export const ERROR_CONTROL_FAILED = -32003;
export const ERROR_HOOK_FAILED = -32004;
export const ERROR_MCP_FAILED = -32005;
export const ERROR_SIDECAR_SHUTTING_DOWN = -32006;
//# sourceMappingURL=protocol.js.map