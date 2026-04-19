defmodule ClaudeAgentSDK.Sidecar.IntegrationTest do
  @moduledoc """
  End-to-end integration tests for the Node sidecar transport.

  Covers acceptance criteria from orchestra-rpx, orchestra-d89,
  orchestra-dh9. Runs in mock mode so no API key is required. Requires
  the sidecar to have been built via `mix claude_agent_sdk.install_sidecar`
  (or `npm run build` under `priv/ts_sidecar`).

  These tests are tagged `:integration` so a fast unit test lane can
  exclude them. Enable via `mix test --only integration` or run with
  `mix test` if no exclusion is configured.
  """

  use ExUnit.Case, async: false

  alias ClaudeAgentSDK.Options.Runtime
  alias ClaudeAgentSDK.Sidecar.Worker
  alias ClaudeAgentSDK.SidecarSession

  @moduletag :integration
  @moduletag timeout: 15_000

  setup_all do
    sidecar_script =
      Path.join([
        Path.expand("../../../", __DIR__),
        "priv",
        "ts_sidecar",
        "dist",
        "index.js"
      ])

    unless File.exists?(sidecar_script) do
      flunk("""
      sidecar script not found at #{sidecar_script}

      Run `mix claude_agent_sdk.install_sidecar` or
      `cd priv/ts_sidecar && npm install && npm run build` first.
      """)
    end

    node = System.find_executable("node") || flunk("node not on PATH")
    {:ok, %{node: node, script: sidecar_script}}
  end

  setup ctx do
    registry_name = :"reg_#{System.unique_integer([:positive])}"
    start_supervised!({Registry, keys: :unique, name: registry_name})

    runtime =
      Runtime.new(
        node_binary: ctx.node,
        sidecar_script: ctx.script,
        env: %{"PATH" => System.get_env("PATH"), "SIDECAR_MOCK" => "1"}
      )

    {:ok, worker} = GenServer.start(Worker, runtime: runtime)
    on_exit(fn -> if Process.alive?(worker), do: Process.exit(worker, :shutdown) end)

    Worker.subscribe(worker)

    receive do
      {:sidecar_ready, params} -> assert params["protocolVersion"] == "1.0"
    after
      5_000 -> flunk("sidecar never emitted sidecar.ready")
    end

    {:ok, worker: worker, registry: registry_name}
  end

  # --- orchestra-cct + orchestra-9dl + orchestra-ozj -----------------------

  test "two concurrent sessions stream without cross-contamination", %{
    worker: worker,
    registry: reg
  } do
    {:ok, a} = GenServer.start(SidecarSession, worker: worker, registry: reg)
    {:ok, b} = GenServer.start(SidecarSession, worker: worker, registry: reg)
    SidecarSession.subscribe(a)
    SidecarSession.subscribe(b)

    {:ok, sid_a} = SidecarSession.create(a)
    {:ok, sid_b} = SidecarSession.create(b)
    :ok = SidecarSession.send_message(a, "I am session A")
    :ok = SidecarSession.send_message(b, "I am session B")
    {:ok, _} = SidecarSession.start_stream(a)
    {:ok, _} = SidecarSession.start_stream(b)

    per_session = collect_stream(%{sid_a => [], sid_b => []}, 2, 1_500)

    reassembled =
      for {sid, msgs} <- per_session, into: %{} do
        text = msgs |> Enum.map(& &1["message"]["text"]) |> Enum.join()
        {sid, text}
      end

    assert reassembled[sid_a] == "echo (mock): I am session A"
    assert reassembled[sid_b] == "echo (mock): I am session B"
  end

  # --- orchestra-rpx — hook bridge ------------------------------------------

  test "hook.fire round-trips to an Elixir handler", %{worker: worker, registry: reg} do
    test_pid = self()

    hook_handler = fn event, payload ->
      send(test_pid, {:hook_fired, event, payload})
      %{decision: "continue"}
    end

    {:ok, s} =
      GenServer.start(SidecarSession,
        worker: worker,
        registry: reg,
        hook_handler: hook_handler,
        hook_events: ["pre_tool_use", "task_completed"]
      )

    SidecarSession.subscribe(s)
    {:ok, _} = SidecarSession.create(s)
    :ok = SidecarSession.send_message(s, "hi")
    {:ok, _} = SidecarSession.start_stream(s)

    assert_receive {:hook_fired, "pre_tool_use", _}, 2_000
    assert_receive {:hook_fired, "task_completed", _}, 2_000

    ctx = SidecarSession.context(s)
    assert length(ctx.hook_fires) == 2
    assert Enum.any?(ctx.hook_fires, &(&1.event == "pre_tool_use"))
    assert Enum.any?(ctx.hook_fires, &(&1.event == "task_completed"))
  end

  test "a denying hook suppresses the stream payload", %{worker: worker, registry: reg} do
    hook_handler = fn "pre_tool_use", _ -> %{decision: "deny", reason: "test denial"} end

    {:ok, s} =
      GenServer.start(SidecarSession,
        worker: worker,
        registry: reg,
        hook_handler: hook_handler,
        hook_events: ["pre_tool_use"]
      )

    SidecarSession.subscribe(s)
    {:ok, _} = SidecarSession.create(s)
    :ok = SidecarSession.send_message(s, "blocked prompt")
    {:ok, _} = SidecarSession.start_stream(s)

    # Expect a "[blocked by hook: ...]" message and stream.end reason=hook_denied
    events = drain(1_500)

    texts =
      Enum.flat_map(events, fn
        {:stream_message, _, %{"message" => %{"text" => t}}} -> [t]
        _ -> []
      end)

    assert Enum.any?(texts, &String.contains?(&1, "blocked by hook"))

    ends = Enum.filter(events, fn {k, _, _} -> k == :stream_end end)
    assert Enum.any?(ends, fn {_, _, p} -> p["reason"] == "hook_denied" end)
  end

  # --- orchestra-d89 — MCP bridge -------------------------------------------

  test "mcp.call round-trips to an Elixir handler", %{worker: worker, registry: reg} do
    test_pid = self()

    mcp_handler = fn server, tool, args ->
      send(test_pid, {:mcp_called, server, tool, args})
      "handled-by-elixir"
    end

    {:ok, s} =
      GenServer.start(SidecarSession,
        worker: worker,
        registry: reg,
        mcp_handler: mcp_handler,
        mcp_tools: [%{server: "orders", tool: "get_order", inputSchema: %{type: "object"}}]
      )

    SidecarSession.subscribe(s)
    {:ok, _} = SidecarSession.create(s)
    :ok = SidecarSession.send_message(s, "need order")
    {:ok, _} = SidecarSession.start_stream(s)

    assert_receive {:mcp_called, "orders", "get_order", _args}, 2_000

    events = drain(1_500)

    combined =
      events
      |> Enum.flat_map(fn
        {:stream_message, _, %{"message" => %{"text" => t}}} -> [t]
        _ -> []
      end)
      |> Enum.join()

    assert String.contains?(combined, "handled-by-elixir")
  end

  # --- orchestra-dh9 — supervision / crash recovery -------------------------

  test "killing the Node process surfaces :sidecar_down to live sessions", %{
    worker: worker,
    registry: reg
  } do
    {:ok, a} = GenServer.start(SidecarSession, worker: worker, registry: reg)
    {:ok, b} = GenServer.start(SidecarSession, worker: worker, registry: reg)
    SidecarSession.subscribe(a)
    SidecarSession.subscribe(b)
    {:ok, sid_a} = SidecarSession.create(a)
    {:ok, sid_b} = SidecarSession.create(b)

    ref_a = Process.monitor(a)
    ref_b = Process.monitor(b)
    ref_w = Process.monitor(worker)

    os_pid = :sys.get_state(worker).os_pid
    {_, 0} = System.cmd("kill", ["-9", Integer.to_string(os_pid)])

    assert_receive {:session_down, ^sid_a, {:sidecar_down, _}}, 2_000
    assert_receive {:session_down, ^sid_b, {:sidecar_down, _}}, 2_000

    # All three processes terminate cleanly
    assert_receive {:DOWN, ^ref_a, :process, ^a, :normal}, 2_000
    assert_receive {:DOWN, ^ref_b, :process, ^b, :normal}, 2_000
    assert_receive {:DOWN, ^ref_w, :process, ^worker, :normal}, 2_000
  end

  # --- helpers --------------------------------------------------------------

  defp drain(window_ms) do
    Stream.unfold(:ok, fn _ ->
      receive do
        msg -> {msg, :ok}
      after
        window_ms -> nil
      end
    end)
    |> Enum.to_list()
  end

  defp collect_stream(acc, ends_expected, window_ms) do
    do_collect(acc, 0, ends_expected, System.monotonic_time(:millisecond) + window_ms)
  end

  defp do_collect(acc, ends_seen, ends_expected, _deadline) when ends_seen >= ends_expected,
    do: acc

  defp do_collect(acc, ends_seen, ends_expected, deadline) do
    now = System.monotonic_time(:millisecond)
    remaining = max(deadline - now, 0)

    receive do
      {:stream_message, sid, params} ->
        do_collect(
          Map.update(acc, sid, [params], &(&1 ++ [params])),
          ends_seen,
          ends_expected,
          deadline
        )

      {:stream_end, _, _} ->
        do_collect(acc, ends_seen + 1, ends_expected, deadline)

      _ ->
        do_collect(acc, ends_seen, ends_expected, deadline)
    after
      remaining -> acc
    end
  end
end
