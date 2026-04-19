defmodule ClaudeAgentSDK.SidecarSession do
  @moduledoc """
  One logical session over the sidecar transport.

  Wraps a single `unstable_v2_createSession` on the Node side. The
  `sessionId` is generated on the Elixir side (UUID v4 string) and
  passed into `session.create` so every downstream method — and every
  inbound notification — carries a stable key for demultiplexing.

  State is intentionally light:
    * `session_id` — opaque UUID
    * `worker` — assigned `Sidecar.Worker` pid
    * `subscribers` — pids receiving stream messages
    * `status` — `:new | :created | :streaming | :closed`
    * `stream_buffer` — accumulated `stream.message` payloads (for demo/context)

  Not a replacement for `ClaudeAgentSDK.Streaming` yet — this is the
  primitive the public API will be ported onto.
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
      status: :new,
      subscribers: [],
      stream_buffer: [],
      stream_id: nil,
      messages_sent: 0,
      created_at: nil
    ]
  end

  # --- Public API -----------------------------------------------------------

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, Keyword.take(opts, [:name]))
  end

  @doc """
  Create the session on the sidecar.

  Required opts:
    * `:worker` — `Sidecar.Worker` pid
    * `:options` — map passed verbatim as TS-side session options

  Optional:
    * `:session_id` — override the generated UUID
    * `:registry` — registry name (default `SessionRegistry.name/0`)
    * `:hook_events` — list of hook event strings to register
    * `:mcp_tools` — list of tool descriptors
    * `:hook_handler` — `(event, payload) -> map` for responding to hook.fire
  """
  def create(session, timeout \\ 15_000) do
    GenServer.call(session, :create, timeout + 2_000)
  end

  def send_message(session, text) when is_binary(text) do
    GenServer.call(session, {:send, %{role: "user", content: text}})
  end

  def start_stream(session, stream_id \\ nil) do
    GenServer.call(session, {:stream_start, stream_id})
  end

  def subscribe(session, pid \\ self()) do
    GenServer.call(session, {:subscribe, pid})
  end

  def context(session), do: GenServer.call(session, :context)

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
      hook_handler: Keyword.get(opts, :hook_handler)
    }

    {:ok, state, {:continue, {:register, opts}}}
  end

  @impl true
  def handle_continue({:register, opts}, state) do
    try_register(state)
    :ok = Worker.register_session(state.worker, state.session_id, self())
    {:noreply, %{state | options: Map.merge(state.options, params_overrides(opts))}}
  end

  defp try_register(state) do
    case Registry.register(state.registry, state.session_id, nil) do
      {:ok, _} -> :ok
      {:error, {:already_registered, _}} -> :ok
    end
  end

  defp params_overrides(opts) do
    %{}
    |> maybe_put(:hook_events, Keyword.get(opts, :hook_events))
    |> maybe_put(:mcp_tools, Keyword.get(opts, :mcp_tools))
  end

  defp maybe_put(m, _, nil), do: m
  defp maybe_put(m, k, v), do: Map.put(m, k, v)

  @impl true
  def handle_call(:session_id, _from, state), do: {:reply, state.session_id, state}

  def handle_call(:create, _from, %{status: :new} = state) do
    params =
      %{
        sessionId: state.session_id,
        options: Map.get(state.options, :sdk_options, %{})
      }
      |> maybe_put(:hookEvents, Map.get(state.options, :hook_events))
      |> maybe_put(:mcpTools, Map.get(state.options, :mcp_tools))

    case Worker.call_rpc(state.worker, Protocol.method_session_create(), params) do
      {:ok, %{"sessionId" => sid, "createdAt" => created_at}} ->
        {:reply, {:ok, sid}, %{state | status: :created, session_id: sid, created_at: created_at}}

      {:error, _} = err ->
        {:reply, err, state}
    end
  end

  def handle_call(:create, _from, state),
    do: {:reply, {:error, {:bad_status, state.status}}, state}

  def handle_call({:send, message}, _from, %{status: s} = state)
      when s in [:created, :streaming] do
    params = %{sessionId: state.session_id, message: message}

    case Worker.call_rpc(state.worker, Protocol.method_session_send(), params) do
      {:ok, _} ->
        {:reply, :ok, %{state | messages_sent: state.messages_sent + 1}}

      err ->
        {:reply, err, state}
    end
  end

  def handle_call({:send, _}, _from, state),
    do: {:reply, {:error, {:bad_status, state.status}}, state}

  def handle_call({:stream_start, sid_opt}, _from, %{status: :created} = state) do
    stream_id = sid_opt || generate_session_id()
    params = %{sessionId: state.session_id, streamId: stream_id}

    case Worker.call_rpc(state.worker, Protocol.method_session_stream_start(), params) do
      {:ok, %{"streamId" => sid}} ->
        {:reply, {:ok, sid}, %{state | status: :streaming, stream_id: sid}}

      err ->
        {:reply, err, state}
    end
  end

  def handle_call({:stream_start, _}, _from, state),
    do: {:reply, {:error, {:bad_status, state.status}}, state}

  def handle_call({:subscribe, pid}, _from, state) do
    Process.monitor(pid)
    {:reply, :ok, %{state | subscribers: [pid | state.subscribers]}}
  end

  def handle_call(:context, _from, state) do
    ctx = %{
      session_id: state.session_id,
      status: state.status,
      created_at: state.created_at,
      messages_sent: state.messages_sent,
      stream_messages_received: length(state.stream_buffer),
      last_stream_messages: Enum.take(Enum.reverse(state.stream_buffer), 10)
    }

    {:reply, ctx, state}
  end

  def handle_call(:close, _from, %{status: :closed} = state),
    do: {:reply, :ok, state}

  def handle_call(:close, _from, state) do
    params = %{sessionId: state.session_id}

    _ =
      Worker.call_rpc(state.worker, Protocol.method_session_close(), params)

    Worker.unregister_session(state.worker, state.session_id)
    {:reply, :ok, %{state | status: :closed}}
  end

  @impl true
  def handle_info({:sidecar_notification, method, params}, state) do
    {:noreply, handle_notification(method, params, state)}
  end

  def handle_info({:sidecar_request, id, method, params, worker}, state) do
    handle_inbound_request(id, method, params, worker, state)
    {:noreply, state}
  end

  def handle_info({:sidecar_down, reason}, state) do
    Enum.each(state.subscribers, &send(&1, {:session_down, state.session_id, reason}))
    {:stop, :normal, %{state | status: :closed}}
  end

  def handle_info({:DOWN, _ref, :process, pid, _}, state) do
    {:noreply, %{state | subscribers: List.delete(state.subscribers, pid)}}
  end

  def handle_info(_, state), do: {:noreply, state}

  # --- helpers --------------------------------------------------------------

  defp handle_notification("stream.message", params, state) do
    Enum.each(state.subscribers, &send(&1, {:stream_message, state.session_id, params}))
    %{state | stream_buffer: [params | state.stream_buffer]}
  end

  defp handle_notification("stream.end", params, state) do
    Enum.each(state.subscribers, &send(&1, {:stream_end, state.session_id, params}))
    %{state | status: :created}
  end

  defp handle_notification("stream.error", params, state) do
    Enum.each(state.subscribers, &send(&1, {:stream_error, state.session_id, params}))
    state
  end

  defp handle_notification(_method, _params, state), do: state

  defp handle_inbound_request(id, "hook.fire", params, worker, %{hook_handler: nil}) do
    Worker.respond(worker, id, %{decision: "continue"})
    :ok
  end

  defp handle_inbound_request(id, "hook.fire", params, worker, %{hook_handler: h}) do
    result =
      try do
        h.(params["event"], params["payload"] || %{})
      rescue
        e ->
          Worker.respond_error(worker, id, -32004, "hook handler raised: #{Exception.message(e)}")
          :handled
      end

    unless result == :handled do
      Worker.respond(worker, id, normalize_hook_result(result))
    end
  end

  defp handle_inbound_request(id, method, _params, worker, _state) do
    Worker.respond_error(worker, id, -32601, "method not implemented in session: #{method}")
  end

  defp normalize_hook_result(r) when is_map(r), do: r
  defp normalize_hook_result(:continue), do: %{decision: "continue"}
  defp normalize_hook_result(:allow), do: %{decision: "allow"}
  defp normalize_hook_result({:deny, reason}), do: %{decision: "deny", reason: reason}
  defp normalize_hook_result(_), do: %{decision: "continue"}

  defp generate_session_id do
    <<a::32, b::16, c::16, d::16, e::48>> = :crypto.strong_rand_bytes(16)

    # UUID v4
    c = Bitwise.band(c, 0x0FFF) |> Bitwise.bor(0x4000)
    d = Bitwise.band(d, 0x3FFF) |> Bitwise.bor(0x8000)

    :io_lib.format("~8.16.0b-~4.16.0b-~4.16.0b-~4.16.0b-~12.16.0b", [a, b, c, d, e])
    |> IO.iodata_to_binary()
  end
end
