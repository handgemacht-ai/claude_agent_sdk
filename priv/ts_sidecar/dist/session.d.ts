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
import type { Writable } from "node:stream";
import { OutboundRpc } from "./rpc.js";
import { type SessionCreateParams, type SessionCreateResult } from "./protocol.js";
type SdkUserMessage = {
    type: "user";
    message: {
        role: "user";
        content: string;
    };
    parent_tool_use_id: null;
};
type SdkMessage = Record<string, unknown>;
type QueryHandle = AsyncGenerator<SdkMessage, void> & {
    interrupt(): Promise<void>;
    setPermissionMode(mode: string): Promise<void>;
    setModel(model?: string): Promise<void>;
    applyFlagSettings(settings: Record<string, unknown>): Promise<void>;
    initializationResult(): Promise<unknown>;
    supportedCommands(): Promise<unknown>;
    supportedModels(): Promise<unknown>;
    supportedAgents(): Promise<unknown>;
    mcpServerStatus(): Promise<unknown>;
    getContextUsage(): Promise<unknown>;
    reloadPlugins(): Promise<unknown>;
    accountInfo(): Promise<unknown>;
    rewindFiles(userMessageId: string, options?: {
        dryRun?: boolean;
    }): Promise<unknown>;
    seedReadState(path: string, mtime: number): Promise<void>;
    reconnectMcpServer(serverName: string): Promise<void>;
    toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
    setMcpServers(servers: Record<string, unknown>): Promise<unknown>;
    stopTask(taskId: string): Promise<void>;
    close(): void;
};
type SdkMcpToolDefinition = {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};
type McpSdkServerConfigWithInstance = {
    type: "sdk";
    name: string;
    instance: unknown;
};
type SdkModule = {
    query: (params: {
        prompt: AsyncIterable<SdkUserMessage>;
        options?: unknown;
    }) => QueryHandle;
    createSdkMcpServer: (opts: {
        name: string;
        version?: string;
        tools?: SdkMcpToolDefinition[];
    }) => McpSdkServerConfigWithInstance;
    tool: (name: string, description: string, inputSchema: Record<string, unknown>, handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>) => SdkMcpToolDefinition;
};
export declare const CONTROL_METHODS: readonly ["interrupt", "setPermissionMode", "setModel", "applyFlagSettings", "initializationResult", "supportedCommands", "supportedModels", "supportedAgents", "mcpServerStatus", "getContextUsage", "reloadPlugins", "accountInfo", "rewindFiles", "seedReadState", "reconnectMcpServer", "toggleMcpServer", "setMcpServers", "stopTask"];
export declare class QuerySession {
    private sdk;
    private rpc;
    private out;
    private query;
    private input;
    private sessionId;
    private createdAt;
    private closed;
    private pumpDone;
    private turnSeq;
    constructor(sdk: SdkModule, rpc: OutboundRpc, out: Writable);
    create(params: SessionCreateParams): Promise<SessionCreateResult>;
    send(content: string, turnId: string | undefined): Promise<string>;
    control(method: string, args: unknown[] | undefined): Promise<unknown>;
    resume(sdkSessionId: string, options: Record<string, unknown>): Promise<void>;
    close(): Promise<void>;
    private nextTurnId;
    private pump;
    /**
     * Inject Elixir-owned bridges into the SDK options:
     *   • `canUseTool` — when `permissionBridge` is set, every prompt for
     *     tool permission goes back to Elixir via `can_use_tool` RPC.
     *   • `hooks` — each declared subscription becomes an SDK HookCallback
     *     that fires `hook.fire` RPC and relays the decision.
     *   • `mcpServers` — each declared tool is grouped by server and
     *     exposed via `createSdkMcpServer`, with handlers proxying
     *     through `mcp.call` RPC.
     */
    private enrichOptions;
    private makeCanUseTool;
    private makeHooks;
    private makeMcpServers;
    private proxyMcpCall;
}
export interface ModeInfo {
    sdkVersion: string;
}
export declare function buildSession(): Promise<{
    make: (rpc: OutboundRpc, out: Writable) => QuerySession;
    info: ModeInfo;
}>;
export {};
