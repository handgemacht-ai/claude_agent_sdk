defmodule ClaudeAgentSDK.SidecarSession do
  @moduledoc """
  One logical session over the sidecar transport.

  Wraps a single `query()` on the Node side. The `sessionId` is
  generated on the Elixir side (UUID v4 string) and passed into
  `session.create` so every subsequent RPC and every inbound
  notification carries a stable key for demultiplexing.

  All SDK messages the model emits (system/init, assistant, result,
  rate_limit_event, hook events, …) are forwarded as
  `{:sdk_message, session_id, message}` to every subscriber.
  """
  use GenServer
  require Logger

  alias ClaudeAgentSDK.JsonRpc.Protocol
  alias ClaudeAgentSDK.Session.Registry, as: SessionRegistry
  alias ClaudeAgentSDK.Sidecar.Worker

  defmodule State do
    @moduledoc false
    defstruct [
      :session_id,
      :worker,
      :registry,
      :options,
      :hook_handler,
      :mcp_handler,
      :can_use_tool_handler,
      status: :new,
      subscribers: [],
      messages: [],
      created_at: nil
    ]
  end

  # --- Public API ------------------------------------------------------------

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, Keyword.take(opts, [:name]))
  end

  @doc """
  Create the session on the sidecar.

  Required opts:
    * `:worker` — `Sidecar.Worker` pid
    * `:options` — map passed verbatim as TS-side `query()` options
      (Agent SDK `Options` shape: model, agents, hooks, mcpServers,
      tools, etc.)

  Optional:
    * `:session_id` — override the generated UUID
    * `:registry` — registry name (default `SessionRegistry.name/0`;
      pass `nil` to skip registration)
    * `:permission_bridge` — when true, SDK `canUseTool` calls route
      back to Elixir as `can_use_tool` RPC (requires
      `:can_use_tool_handler`)
    * `:hook_handler` — `(event, payload) -> map` for responding to
      hook.fire callbacks
    * `:mcp_handler` — `(server, tool, args) -> map` for responding to
      mcp.call callbacks
    * `:can_use_tool_handler` — `(tool_name, input) -> map` for the
      permission bridge
  """
  def create(session, timeout \\ 30_000) when is_integer(timeout) do
    GenServer.call(session, :create, timeout + 2_000)
  end

  @doc "Send a user message. Returns `{:ok, turn_id}`."
  def send_message(session, content) when is_binary(content) do
    GenServer.call(session, {:send, content})
  end

  @doc """
  Invoke a `Query` control method by name.

  Supported methods (from the SDK's `Query` interface):
  `interrupt`, `setPermissionMode`, `setModel`, `applyFlagSettings`,
  `initializationResult`, `supportedCommands`, `supportedModels`,
  `supportedAgents`, `mcpServerStatus`, `getContextUsage`,
  `reloadPlugins`, `accountInfo`, `rewindFiles`, `seedReadState`,
  `reconnectMcpServer`, `toggleMcpServer`, `setMcpServers`, `stopTask`.
  """
  def control(session, method, args \\ []) when is_binary(method) and is_list(args) do
    GenServer.call(session, {:control, method, args}, 60_000)
  end

  # Convenience wrappers for the most-used control methods.
  def get_context_usage(session), do: control(session, "getContextUsage")
  def supported_agents(session), do: control(session, "supportedAgents")
  def supported_commands(session), do: control(session, "supportedCommands")
  def supported_models(session), do: control(session, "supportedModels")
  def initialization_result(session), do: control(session, "initializationResult")
  def mcp_server_status(session), do: control(session, "mcpServerStatus")
  def account_info(session), do: control(session, "accountInfo")
  def interrupt(session), do: control(session, "interrupt")
  def set_model(session, model), do: control(session, "setModel", [model])

  def set_permission_mode(session, mode),
    do: control(session, "setPermissionMode", [mode])

  def subscribe(session, pid \\ self()) do
    GenServer.call(session, {:subscribe, pid})
  end

  def close(session), do: GenServer.call(session, :close)

  def session_id(session), do: GenServer.call(session, :session_id)

  # --- GenServer ------------------------------------------------------------

  @impl true
  def init(opts) do
    worker = Keyword.fetch!(opts, :worker)
    options = Keyword.get(opts, :options, %{})
    registry = Keyword.get(opts, :registry, SessionRegistry.name())
    session_id = Keyword.get_lazy(opts, :session_id, &generate_session_id/0)

    state = %State{
      session_id: session_id,
      worker: worker,
      registry: registry,
      options: options,
      hook_handler: Keyword.get(opts, :hook_handler),
      mcp_handler: Keyword.get(opts, :mcp_handler),
      can_use_tool_handler: Keyword.get(opts, :can_use_tool_handler)
    }

    {:ok, state, {:continue, :register}}
  end

  @impl true
  def handle_continue(:register, state) do
    try_register(state)
    :ok = Worker.register_session(state.worker, state.session_id, self())
    {:noreply, state}
  end

  defp try_register(%{registry: nil}), do: :ok

  defp try_register(state) do
    if Process.whereis(state.registry) do
      SessionRegistry.register(state.registry, state.session_id, self())
    else
      :ok
    end
  end

  @impl true
  def handle_call(:session_id, _from, state), do: {:reply, state.session_id, state}

  def handle_call({:subscribe, pid}, _from, state) do
    Process.monitor(pid)
    {:reply, :ok, %{state | subscribers: [pid | state.subscribers]}}
  end

  def handle_call(:create, _from, %{status: :new} = state) do
    params = %{
      sessionId: state.session_id,
      options: state.options,
      permissionBridge: not is_nil(state.can_use_tool_handler)
    }

    case Worker.call_rpc(state.worker, Protocol.method_session_create(), params) do
      {:ok, %{"sessionId" => sid, "createdAt" => at}} ->
        {:reply, {:ok, sid}, %{state | status: :ready, session_id: sid, created_at: at}}

      err ->
        {:reply, err, state}
    end
  end

  def handle_call(:create, _from, state),
    do: {:reply, {:error, {:bad_status, state.status}}, state}

  def handle_call({:send, content}, _from, %{status: :ready} = state) do
    params = %{sessionId: state.session_id, content: content}

    case Worker.call_rpc(state.worker, Protocol.method_session_send(), params) do
      {:ok, %{"turnId" => turn_id}} -> {:reply, {:ok, turn_id}, state}
      err -> {:reply, err, state}
    end
  end

  def handle_call({:send, _}, _from, state),
    do: {:reply, {:error, {:bad_status, state.status}}, state}

  def handle_call({:control, method, args}, _from, %{status: :ready} = state) do
    params = %{sessionId: state.session_id, method: method, args: args}

    case Worker.call_rpc(state.worker, Protocol.method_session_control(), params, timeout: 60_000) do
      {:ok, %{"value" => value}} -> {:reply, {:ok, value}, state}
      err -> {:reply, err, state}
    end
  end

  def handle_call({:control, _, _}, _from, state),
    do: {:reply, {:error, {:bad_status, state.status}}, state}

  def handle_call(:close, _from, %{status: :closed} = state), do: {:reply, :ok, state}

  def handle_call(:close, _from, state) do
    params = %{sessionId: state.session_id}
    _ = Worker.call_rpc(state.worker, Protocol.method_session_close(), params)
    Worker.unregister_session(state.worker, state.session_id)
    {:reply, :ok, %{state | status: :closed}}
  end

  @impl true
  def handle_info({:sidecar_notification, method, params}, state) do
    {:noreply, handle_notification(method, params, state)}
  end

  def handle_info({:sidecar_request, id, method, params, worker}, state) do
    {:noreply, handle_inbound_request(id, method, params, worker, state)}
  end

  def handle_info({:sidecar_down, reason}, state) do
    Enum.each(state.subscribers, &send(&1, {:session_down, state.session_id, reason}))
    {:stop, :normal, %{state | status: :closed}}
  end

  def handle_info({:DOWN, _ref, :process, pid, _}, state) do
    {:noreply, %{state | subscribers: List.delete(state.subscribers, pid)}}
  end

  def handle_info(_, state), do: {:noreply, state}

  # --- notification/inbound request routing ---------------------------------

  defp handle_notification("session.message", %{"message" => message}, state) do
    Enum.each(state.subscribers, &send(&1, {:sdk_message, state.session_id, message}))
    state
  end

  defp handle_notification("session.error", %{"error" => err}, state) do
    Enum.each(state.subscribers, &send(&1, {:session_error, state.session_id, err}))
    state
  end

  defp handle_notification("session.closed", %{"reason" => reason}, state) do
    Enum.each(state.subscribers, &send(&1, {:session_closed, state.session_id, reason}))
    %{state | status: :closed}
  end

  defp handle_notification(_method, _params, state), do: state

  defp handle_inbound_request(id, "hook.fire", params, worker, state) do
    event = params["event"]
    payload = params["payload"] || %{}

    reply =
      case state.hook_handler do
        nil -> %{decision: "continue"}
        h when is_function(h, 2) -> normalize_hook_result(h.(event, payload))
      end

    Worker.respond(worker, id, reply)
    state
  rescue
    e ->
      Worker.respond_error(worker, id, -32_004, "hook handler raised: #{Exception.message(e)}")
      state
  end

  defp handle_inbound_request(id, "mcp.call", params, worker, state) do
    server = params["server"]
    tool = params["tool"]
    args = params["args"] || %{}

    case state.mcp_handler do
      nil ->
        Worker.respond_error(worker, id, -32_005, "no mcp_handler registered", %{
          server: server,
          tool: tool
        })

      h when is_function(h, 3) ->
        Worker.respond(worker, id, normalize_mcp_result(h.(server, tool, args)))
    end

    state
  rescue
    e ->
      Worker.respond_error(worker, id, -32_005, "mcp handler raised: #{Exception.message(e)}")
      state
  end

  defp handle_inbound_request(id, "can_use_tool", params, worker, state) do
    tool_name = params["toolName"]
    input = params["input"] || %{}

    case state.can_use_tool_handler do
      nil ->
        Worker.respond(worker, id, %{behavior: "allow"})

      h when is_function(h, 2) ->
        Worker.respond(worker, id, normalize_permission_result(h.(tool_name, input)))
    end

    state
  rescue
    e ->
      Worker.respond_error(
        worker,
        id,
        -32_003,
        "permission handler raised: #{Exception.message(e)}"
      )

      state
  end

  defp handle_inbound_request(id, method, _params, worker, state) do
    Worker.respond_error(worker, id, -32_601, "method not implemented in session: #{method}")
    state
  end

  defp normalize_hook_result(r) when is_map(r), do: r
  defp normalize_hook_result(:continue), do: %{decision: "continue"}
  defp normalize_hook_result(:allow), do: %{decision: "allow"}
  defp normalize_hook_result({:deny, reason}), do: %{decision: "deny", reason: reason}
  defp normalize_hook_result(_), do: %{decision: "continue"}

  defp normalize_mcp_result(%{content: _} = m), do: m
  defp normalize_mcp_result(%{"content" => _} = m), do: m

  defp normalize_mcp_result(text) when is_binary(text),
    do: %{content: [%{type: "text", text: text}]}

  defp normalize_mcp_result(other),
    do: %{content: [%{type: "text", text: inspect(other)}]}

  defp normalize_permission_result(%{behavior: _} = m), do: m
  defp normalize_permission_result(%{"behavior" => _} = m), do: m
  defp normalize_permission_result(:allow), do: %{behavior: "allow"}

  defp normalize_permission_result({:allow, input}) when is_map(input),
    do: %{behavior: "allow", updatedInput: input}

  defp normalize_permission_result({:deny, msg}), do: %{behavior: "deny", message: msg}
  defp normalize_permission_result(_), do: %{behavior: "allow"}

  defp generate_session_id do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)

    c = Bitwise.band(c, 0x0FFF) |> Bitwise.bor(0x4000)
    d = Bitwise.band(d, 0x3FFF) |> Bitwise.bor(0x8000)

    :io_lib.format("~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b", [a, b, c, d, e])
    |> IO.iodata_to_binary()
  end
end
