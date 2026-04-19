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

export const PROTOCOL_VERSION = "2.0" as const;

// Elixir → Node (request/response)
export const METHOD_SESSION_CREATE = "session.create" as const;
export const METHOD_SESSION_SEND = "session.send" as const;
export const METHOD_SESSION_CONTROL = "session.control" as const;
export const METHOD_SESSION_RESUME = "session.resume" as const;
export const METHOD_SESSION_CLOSE = "session.close" as const;
export const METHOD_PING = "ping" as const;
export const METHOD_SHUTDOWN = "shutdown" as const;

// Node → Elixir (request/response)
export const METHOD_HOOK_FIRE = "hook.fire" as const;
export const METHOD_MCP_CALL = "mcp.call" as const;
export const METHOD_CAN_USE_TOOL = "can_use_tool" as const;

// Notifications (no id, no response)
export const NOTIF_SIDECAR_READY = "sidecar.ready" as const;
export const NOTIF_SESSION_MESSAGE = "session.message" as const;
export const NOTIF_SESSION_ERROR = "session.error" as const;
export const NOTIF_SESSION_CLOSED = "session.closed" as const;
export const NOTIF_LOG = "log" as const;

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
] as const;

export const NOTIFICATIONS = [
  NOTIF_SIDECAR_READY,
  NOTIF_SESSION_MESSAGE,
  NOTIF_SESSION_ERROR,
  NOTIF_SESSION_CLOSED,
  NOTIF_LOG,
] as const;

export type MethodName = (typeof METHODS)[number];
export type NotificationName = (typeof NOTIFICATIONS)[number];

// Error codes
export const ERROR_PARSE = -32700 as const;
export const ERROR_INVALID_REQUEST = -32600 as const;
export const ERROR_METHOD_NOT_FOUND = -32601 as const;
export const ERROR_INVALID_PARAMS = -32602 as const;
export const ERROR_INTERNAL = -32603 as const;

export const ERROR_SESSION_UNKNOWN = -32001 as const;
export const ERROR_SESSION_CLOSED = -32002 as const;
export const ERROR_CONTROL_FAILED = -32003 as const;
export const ERROR_HOOK_FAILED = -32004 as const;
export const ERROR_MCP_FAILED = -32005 as const;
export const ERROR_SIDECAR_SHUTTING_DOWN = -32006 as const;

export type SessionId = string;
export type TurnId = string;
export type RpcId = number | string;

// Request params / results

export interface SessionCreateParams {
  sessionId: SessionId;
  /** Passed to query() as `options`. Full `Options` shape from the SDK. */
  options: Record<string, unknown>;
  /** When true, Elixir wants `can_use_tool` RPC calls routed back. */
  permissionBridge?: boolean;
  /** Names of hook events Elixir wants to be notified about (future use). */
  hookEvents?: string[];
}

export interface SessionCreateResult {
  sessionId: SessionId;
  createdAt: string;
}

export interface SessionSendParams {
  sessionId: SessionId;
  /** Raw user-visible text. Wrapped as SDKUserMessage on the sidecar side. */
  content: string;
  turnId?: TurnId;
}

export interface SessionSendResult {
  turnId: TurnId;
}

export interface SessionControlParams {
  sessionId: SessionId;
  /**
   * Name of a `Query` control method.
   * See `src/session.ts#CONTROL_METHODS`.
   */
  method: string;
  args?: unknown[];
}

export interface SessionControlResult {
  /** Whatever the underlying Query method returned, JSON-encoded. */
  value: unknown;
}

export interface SessionResumeParams {
  sessionId: SessionId;
  /** SDK-side session id to resume. Usually surfaced via init message. */
  sdkSessionId: string;
  options: Record<string, unknown>;
}

export interface SessionResumeResult {
  sessionId: SessionId;
  resumedAt: string;
}

export interface SessionCloseParams {
  sessionId: SessionId;
}

export interface SessionCloseResult {
  closed: boolean;
}

export interface PingParams {}

export interface PingResult {
  pong: boolean;
  serverTime: string;
}

export interface ShutdownParams {}

export interface ShutdownResult {
  shuttingDown: boolean;
}

// Node → Elixir requests

export interface HookFireParams {
  sessionId: SessionId;
  event: string;
  payload: Record<string, unknown>;
}

export interface HookFireResult {
  decision?: "allow" | "deny" | "ask" | "continue" | "block";
  reason?: string;
  systemMessage?: string;
  modifiedInput?: Record<string, unknown>;
}

export interface McpCallParams {
  sessionId: SessionId;
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
}

export interface CanUseToolParams {
  sessionId: SessionId;
  toolName: string;
  input: Record<string, unknown>;
}

export type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };

// Notifications

export interface SidecarReadyParams {
  protocolVersion: string;
  sidecarVersion: string;
  sdkVersion: string;
  nodeVersion: string;
}

export interface SessionMessageParams {
  sessionId: SessionId;
  /** One SDK message (system/init, assistant, user, result, …). */
  message: Record<string, unknown>;
}

export interface SessionErrorParams {
  sessionId: SessionId;
  error: { code: number; message: string; data?: unknown };
}

export interface SessionClosedParams {
  sessionId: SessionId;
  reason: string;
}

export interface LogParams {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  sessionId?: SessionId;
  fields?: Record<string, unknown>;
}

// JSON-RPC envelopes

export interface JsonRpcRequest<P = Record<string, unknown>> {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params: P;
}

export interface JsonRpcNotification<P = Record<string, unknown>> {
  jsonrpc: "2.0";
  method: string;
  params: P;
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc: "2.0";
  id: RpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: RpcId;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse<R = unknown> =
  | JsonRpcSuccessResponse<R>
  | JsonRpcErrorResponse;

export interface MethodMap {
  [METHOD_SESSION_CREATE]: { params: SessionCreateParams; result: SessionCreateResult };
  [METHOD_SESSION_SEND]: { params: SessionSendParams; result: SessionSendResult };
  [METHOD_SESSION_CONTROL]: { params: SessionControlParams; result: SessionControlResult };
  [METHOD_SESSION_RESUME]: { params: SessionResumeParams; result: SessionResumeResult };
  [METHOD_SESSION_CLOSE]: { params: SessionCloseParams; result: SessionCloseResult };
  [METHOD_PING]: { params: PingParams; result: PingResult };
  [METHOD_SHUTDOWN]: { params: ShutdownParams; result: ShutdownResult };
  [METHOD_HOOK_FIRE]: { params: HookFireParams; result: HookFireResult };
  [METHOD_MCP_CALL]: { params: McpCallParams; result: McpCallResult };
  [METHOD_CAN_USE_TOOL]: { params: CanUseToolParams; result: CanUseToolResult };
}

export interface NotificationMap {
  [NOTIF_SIDECAR_READY]: SidecarReadyParams;
  [NOTIF_SESSION_MESSAGE]: SessionMessageParams;
  [NOTIF_SESSION_ERROR]: SessionErrorParams;
  [NOTIF_SESSION_CLOSED]: SessionClosedParams;
  [NOTIF_LOG]: LogParams;
}
