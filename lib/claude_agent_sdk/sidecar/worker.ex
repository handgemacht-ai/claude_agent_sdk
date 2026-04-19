defmodule ClaudeAgentSDK.Sidecar.Worker do
  @moduledoc """
  Owns one Node sidecar process.

  Responsibilities:
    * spawn/terminate the Node process via `Port.open/2` with `:line` framing
    * write JSON-RPC requests, correlate responses by `id`
    * demultiplex inbound notifications by `sessionId` and route to
      the owning `Session` GenServer via the configured `Registry`
    * on abnormal Node exit, surface `{:sidecar_down, reason}` to every
      currently-assigned Session

  Does not know hook semantics, MCP bridge semantics, or message
  decoding beyond JSON-RPC framing. Those are per-session concerns.
  """
  use GenServer
  require Logger

  alias ClaudeAgentSDK.JsonRpc.Framing

  @default_call_timeout 30_000
  @max_line_bytes 8 * 1024 * 1024

  defmodule State do
    @moduledoc false
    defstruct [
      :port,
      :runtime,
      :registry,
      :os_pid,
      :ready?,
      :exited_reason,
      pending: %{},
      next_id: 1,
      sessions: %{},
      buffer: "",
      subscribers: []
    ]
  end

  # --- Public API -----------------------------------------------------------

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, Keyword.take(opts, [:name]))
  end

  @doc """
  Issue a JSON-RPC request and await the response synchronously.

  Returns `{:ok, result}` | `{:error, {:rpc, code, msg, data}}` |
  `{:error, :sidecar_down}` | `{:error, :timeout}`.
  """
  def call_rpc(worker, method, params, opts \\ []) do
    timeout = Keyword.get(opts, :timeout, @default_call_timeout)
    GenServer.call(worker, {:rpc, method, params, timeout}, timeout + 1_000)
  end

  @doc "Register caller as recipient of session-scoped notifications."
  def register_session(worker, session_id, pid \\ self()) do
    GenServer.call(worker, {:register_session, session_id, pid})
  end

  def unregister_session(worker, session_id) do
    GenServer.call(worker, {:unregister_session, session_id})
  end

  @doc """
  Subscribe to ALL non-session-scoped worker events (sidecar.ready, log, …).
  Useful for tests and bootstrapping.
  """
  def subscribe(worker, pid \\ self()) do
    GenServer.call(worker, {:subscribe, pid})
  end

  def stop(worker, reason \\ :normal), do: GenServer.stop(worker, reason)

  # --- GenServer callbacks --------------------------------------------------

  @impl true
  def init(opts) do
    runtime = Keyword.fetch!(opts, :runtime)
    registry = Keyword.get(opts, :registry)

    port_opts =
      [
        :binary,
        :exit_status,
        :use_stdio,
        :hide,
        {:line, @max_line_bytes},
        {:args, [runtime.sidecar_script]},
        {:env, build_env(runtime.env)}
      ]
      |> maybe_add_cd(runtime.working_directory)

    port = Port.open({:spawn_executable, runtime.node_binary}, port_opts)
    os_pid = Port.info(port, :os_pid) |> elem(1)

    state = %State{
      port: port,
      runtime: runtime,
      registry: registry,
      os_pid: os_pid,
      ready?: false
    }

    {:ok, state}
  end

  @impl true
  def handle_call({:rpc, method, params, _timeout}, from, state) do
    id = state.next_id
    iodata = Framing.encode_request(id, method, params)
    true = Port.command(state.port, iodata)

    state = %{
      state
      | pending: Map.put(state.pending, id, from),
        next_id: id + 1
    }

    {:noreply, state}
  end

  def handle_call({:register_session, session_id, pid}, _from, state) do
    Process.monitor(pid)
    {:reply, :ok, %{state | sessions: Map.put(state.sessions, session_id, pid)}}
  end

  def handle_call({:unregister_session, session_id}, _from, state) do
    {:reply, :ok, %{state | sessions: Map.delete(state.sessions, session_id)}}
  end

  def handle_call({:subscribe, pid}, _from, state) do
    Process.monitor(pid)
    {:reply, :ok, %{state | subscribers: [pid | state.subscribers]}}
  end

  @impl true
  def handle_info({port, {:data, {:eol, chunk}}}, %{port: port} = state) do
    full = state.buffer <> chunk
    handle_frame(full, %{state | buffer: ""})
  end

  def handle_info({port, {:data, {:noeol, chunk}}}, %{port: port} = state) do
    {:noreply, %{state | buffer: state.buffer <> chunk}}
  end

  def handle_info({port, {:exit_status, status}}, %{port: port} = state) do
    Logger.warning("sidecar exited with status #{status}")
    reason = {:sidecar_down, {:exit_status, status}}
    notify_sessions_down(state, reason)
    notify_pending_down(state, reason)
    {:stop, :normal, %{state | exited_reason: reason}}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    sessions =
      state.sessions
      |> Enum.reject(fn {_id, spid} -> spid == pid end)
      |> Map.new()

    subs = List.delete(state.subscribers, pid)
    {:noreply, %{state | sessions: sessions, subscribers: subs}}
  end

  def handle_info(msg, state) do
    Logger.debug("Sidecar.Worker unexpected msg: #{inspect(msg)}")
    {:noreply, state}
  end

  @impl true
  def terminate(_reason, %{port: port}) when is_port(port) do
    try do
      Port.close(port)
    catch
      :error, :badarg -> :ok
    end

    :ok
  end

  def terminate(_reason, _state), do: :ok

  # --- frame handling -------------------------------------------------------

  defp handle_frame(line, state) do
    case Framing.decode(line) do
      {:ok, {:response_ok, id, result}} ->
        state = reply_pending(state, id, {:ok, result})
        {:noreply, state}

      {:ok, {:response_error, id, code, msg, data}} ->
        state = reply_pending(state, id, {:error, {:rpc, code, msg, data}})
        {:noreply, state}

      {:ok, {:notification, method, params}} ->
        route_notification(method, params, state)
        {:noreply, state}

      {:ok, {:request, id, method, params}} ->
        route_inbound_request(id, method, params, state)
        {:noreply, state}

      {:error, reason} ->
        Logger.warning("sidecar frame decode failed: #{inspect(reason)} line=#{inspect(line)}")
        {:noreply, state}
    end
  end

  defp reply_pending(state, id, reply) do
    case Map.pop(state.pending, id) do
      {nil, pending} ->
        Logger.warning("sidecar response for unknown id #{inspect(id)}")
        %{state | pending: pending}

      {from, pending} ->
        GenServer.reply(from, reply)
        %{state | pending: pending}
    end
  end

  defp route_notification("sidecar.ready", params, state) do
    broadcast(state.subscribers, {:sidecar_ready, params})
  end

  defp route_notification(method, params, state) do
    case Map.get(params, "sessionId") do
      nil ->
        broadcast(state.subscribers, {:sidecar_event, method, params})

      sid ->
        case Map.get(state.sessions, sid) do
          nil ->
            broadcast(state.subscribers, {:sidecar_event, method, params})

          pid ->
            send(pid, {:sidecar_notification, method, params})
        end
    end
  end

  defp route_inbound_request(id, method, params, state) do
    # Node → Elixir requests (hook.fire, mcp.call). Route to the session;
    # the session replies via a worker-local helper that encodes the response.
    sid = Map.get(params, "sessionId")

    case sid && Map.get(state.sessions, sid) do
      nil ->
        reply =
          Framing.encode_error(
            id,
            -32001,
            "session not found or no recipient",
            %{sessionId: sid, method: method}
          )

        Port.command(state.port, reply)

      pid ->
        send(pid, {:sidecar_request, id, method, params, self()})
    end
  end

  @doc false
  def respond(worker, id, result), do: GenServer.cast(worker, {:respond, id, result})

  @doc false
  def respond_error(worker, id, code, msg, data \\ nil),
    do: GenServer.cast(worker, {:respond_error, id, code, msg, data})

  @impl true
  def handle_cast({:respond, id, result}, state) do
    Port.command(state.port, Framing.encode_response(id, result))
    {:noreply, state}
  end

  def handle_cast({:respond_error, id, code, msg, data}, state) do
    Port.command(state.port, Framing.encode_error(id, code, msg, data))
    {:noreply, state}
  end

  defp broadcast(subs, msg), do: Enum.each(subs, &send(&1, msg))

  defp notify_sessions_down(state, reason) do
    Enum.each(state.sessions, fn {_sid, pid} ->
      send(pid, {:sidecar_down, reason})
    end)
  end

  defp notify_pending_down(state, reason) do
    Enum.each(state.pending, fn {_id, from} ->
      GenServer.reply(from, {:error, reason})
    end)
  end

  defp build_env(env_map) do
    Enum.map(env_map, fn {k, v} -> {String.to_charlist(k), String.to_charlist(v)} end)
  end

  defp maybe_add_cd(opts, nil), do: opts
  defp maybe_add_cd(opts, cwd) when is_binary(cwd), do: [{:cd, String.to_charlist(cwd)} | opts]
end
