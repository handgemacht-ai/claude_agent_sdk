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
import { createRequire } from "node:module";
import { send } from "./framing.js";
import { OutboundRpc } from "./rpc.js";
import {
  NOTIF_LOG,
  NOTIF_SESSION_CLOSED,
  NOTIF_SESSION_ERROR,
  NOTIF_SESSION_MESSAGE,
  METHOD_CAN_USE_TOOL,
  METHOD_HOOK_FIRE,
  METHOD_MCP_CALL,
  type CanUseToolResult,
  type HookFireResult,
  type HookSubscription,
  type McpCallResult,
  type McpToolSpec,
  type SessionCreateParams,
  type SessionCreateResult,
} from "./protocol.js";

type SdkUserMessage = {
  type: "user";
  message: { role: "user"; content: string };
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
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<unknown>;
  seedReadState(path: string, mtime: number): Promise<void>;
  reconnectMcpServer(serverName: string): Promise<void>;
  toggleMcpServer(serverName: string, enabled: boolean): Promise<void>;
  setMcpServers(servers: Record<string, unknown>): Promise<unknown>;
  stopTask(taskId: string): Promise<void>;
  close(): void;
};

type HookCallback = (
  input: Record<string, unknown>,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<Record<string, unknown>>;

type HookCallbackMatcher = {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
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
  query: (params: { prompt: AsyncIterable<SdkUserMessage>; options?: unknown }) => QueryHandle;
  createSdkMcpServer: (opts: {
    name: string;
    version?: string;
    tools?: SdkMcpToolDefinition[];
  }) => McpSdkServerConfigWithInstance;
  tool: (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>,
  ) => SdkMcpToolDefinition;
};

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
] as const;

type ControlMethod = (typeof CONTROL_METHODS)[number];

function isControlMethod(name: string): name is ControlMethod {
  return (CONTROL_METHODS as readonly string[]).includes(name);
}

interface InputChannel {
  iterable: AsyncIterable<SdkUserMessage>;
  push(msg: SdkUserMessage): void;
  close(): void;
}

function makeInputChannel(): InputChannel {
  const queue: SdkUserMessage[] = [];
  const resolvers: Array<(r: IteratorResult<SdkUserMessage, void>) => void> = [];
  let closed = false;

  const iterable: AsyncIterable<SdkUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SdkUserMessage, void>> {
          if (queue.length > 0) {
            return Promise.resolve({ value: queue.shift()!, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => resolvers.push(resolve));
        },
        return(): Promise<IteratorResult<SdkUserMessage, void>> {
          closed = true;
          while (resolvers.length) resolvers.shift()!({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    iterable,
    push(msg) {
      if (closed) throw new Error("input channel closed");
      const r = resolvers.shift();
      if (r) r({ value: msg, done: false });
      else queue.push(msg);
    },
    close() {
      closed = true;
      while (resolvers.length) resolvers.shift()!({ value: undefined, done: true });
    },
  };
}

export class QuerySession {
  private query!: QueryHandle;
  private input!: InputChannel;
  private sessionId!: string;
  private createdAt!: string;
  private closed = false;
  private pumpDone!: Promise<void>;
  private turnSeq = 0;

  constructor(
    private sdk: SdkModule,
    private rpc: OutboundRpc,
    private out: Writable,
  ) {}

  async create(params: SessionCreateParams): Promise<SessionCreateResult> {
    this.sessionId = params.sessionId;
    this.input = makeInputChannel();

    const options = this.enrichOptions(params.options, params);
    this.query = this.sdk.query({ prompt: this.input.iterable, options });
    this.createdAt = new Date().toISOString();
    this.pumpDone = this.pump();
    return { sessionId: this.sessionId, createdAt: this.createdAt };
  }

  async send(content: string, turnId: string | undefined): Promise<string> {
    if (this.closed) throw new Error("session closed");
    const assigned = turnId ?? this.nextTurnId();
    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    });
    return assigned;
  }

  async control(method: string, args: unknown[] | undefined): Promise<unknown> {
    if (this.closed) throw new Error("session closed");
    if (!isControlMethod(method)) {
      throw new Error(`unknown control method: ${method}`);
    }
    const handle = this.query as unknown as Record<string, (...a: unknown[]) => unknown>;
    const fn = handle[method];
    if (typeof fn !== "function") {
      throw new Error(`Query does not expose ${method}`);
    }
    return await fn.apply(this.query, args ?? []);
  }

  async resume(sdkSessionId: string, options: Record<string, unknown>): Promise<void> {
    this.input.close();
    try {
      this.query.close();
    } catch {
      /* fine */
    }
    this.input = makeInputChannel();
    const merged = { ...options, resume: sdkSessionId };
    const enriched = this.enrichOptions(merged, {
      sessionId: this.sessionId,
      options: merged,
    });
    this.query = this.sdk.query({ prompt: this.input.iterable, options: enriched });
    this.closed = false;
    this.pumpDone = this.pump();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    try {
      this.query.close();
    } catch {
      /* fine */
    }
    try {
      await this.pumpDone;
    } catch {
      /* pump resolves on close */
    }
  }

  private nextTurnId(): string {
    this.turnSeq += 1;
    return `turn-${this.turnSeq}`;
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.query) {
        if (this.closed) break;
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
    } catch (err) {
      send(this.out, {
        jsonrpc: "2.0",
        method: NOTIF_SESSION_ERROR,
        params: {
          sessionId: this.sessionId,
          error: { code: -32010, message: (err as Error).message },
        },
      });
    }
  }

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
  private enrichOptions(
    options: Record<string, unknown>,
    params: SessionCreateParams,
  ): Record<string, unknown> {
    let enriched: Record<string, unknown> = { ...options };

    if (params.permissionBridge) {
      enriched.canUseTool = this.makeCanUseTool();
    }

    if (params.hookSubscriptions && params.hookSubscriptions.length > 0) {
      const hooks = this.makeHooks(params.hookSubscriptions);
      const existing = (enriched.hooks as Record<string, unknown[]>) ?? {};
      enriched.hooks = mergeHooks(existing, hooks);
    }

    if (params.mcpTools && params.mcpTools.length > 0) {
      const servers = this.makeMcpServers(params.mcpTools);
      const existing = (enriched.mcpServers as Record<string, unknown>) ?? {};
      enriched.mcpServers = { ...existing, ...servers };
    }

    return enriched;
  }

  private makeCanUseTool() {
    return async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<CanUseToolResult> => {
      return await this.rpc.call<CanUseToolResult>(METHOD_CAN_USE_TOOL, {
        sessionId: this.sessionId,
        toolName,
        input,
      });
    };
  }

  private makeHooks(
    subs: HookSubscription[],
  ): Record<string, HookCallbackMatcher[]> {
    const out: Record<string, HookCallbackMatcher[]> = {};
    for (const s of subs) {
      const cb: HookCallback = async (input, toolUseId) => {
        const res = await this.rpc.call<HookFireResult>(METHOD_HOOK_FIRE, {
          sessionId: this.sessionId,
          event: s.event,
          payload: { ...input, toolUseId },
        });
        return res as Record<string, unknown>;
      };
      const matcher: HookCallbackMatcher = {
        matcher: s.matcher,
        hooks: [cb],
        timeout: s.timeout,
      };
      (out[s.event] ??= []).push(matcher);
    }
    return out;
  }

  private makeMcpServers(
    tools: McpToolSpec[],
  ): Record<string, McpSdkServerConfigWithInstance> {
    const byServer = new Map<string, McpToolSpec[]>();
    for (const t of tools) {
      const list = byServer.get(t.server) ?? [];
      list.push(t);
      byServer.set(t.server, list);
    }

    const servers: Record<string, McpSdkServerConfigWithInstance> = {};
    for (const [serverName, specs] of byServer) {
      const sdkTools = specs.map((spec) =>
        this.sdk.tool(
          spec.name,
          spec.description,
          spec.inputSchema ?? {},
          async (args) => this.proxyMcpCall(serverName, spec.name, args),
        ),
      );
      servers[serverName] = this.sdk.createSdkMcpServer({
        name: serverName,
        tools: sdkTools,
      });
    }
    return servers;
  }

  private async proxyMcpCall(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    return await this.rpc.call<McpCallResult>(METHOD_MCP_CALL, {
      sessionId: this.sessionId,
      server,
      tool,
      args,
    });
  }
}

function mergeHooks(
  a: Record<string, unknown[]>,
  b: Record<string, HookCallbackMatcher[]>,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = [...(out[k] ?? []), ...v];
  }
  return out;
}

export interface ModeInfo {
  sdkVersion: string;
}

export async function buildSession(): Promise<{
  make: (rpc: OutboundRpc, out: Writable) => QuerySession;
  info: ModeInfo;
}> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as SdkModule;
  if (typeof mod.query !== "function") {
    throw new Error("installed @anthropic-ai/claude-agent-sdk does not export query()");
  }
  return {
    make: (rpc, out) => new QuerySession(mod, rpc, out),
    info: { sdkVersion: readSdkVersion() },
  };
}

function readSdkVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("@anthropic-ai/claude-agent-sdk/package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
