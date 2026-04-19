defmodule ClaudeAgentSDK.Sidecar.ParityTest do
  @moduledoc """
  Parity harness for orchestra-t28.

  Goal per the epic: under a fixed prompt, `preferred_transport: :cli`
  and `preferred_transport: :sidecar` must produce equivalent
  `Message` structs after timestamp normalization. This gates the N+2
  default flip.

  Current state: this file runs **sidecar-vs-sidecar determinism**
  (two independent sidecar invocations in mock mode) as a structural
  harness. The CLI leg is pending a separate fix — CLI transport on
  `main` currently fails to compile (missing
  `ExternalRuntimeTransport`) so real CLI-vs-sidecar comparison has to
  wait on that unblock. The comparison helpers here are the ones the
  CLI leg will eventually plug into.
  """

  use ExUnit.Case, async: false

  alias ClaudeAgentSDK.Options.Runtime
  alias ClaudeAgentSDK.Sidecar.Worker
  alias ClaudeAgentSDK.SidecarSession

  @moduletag :integration
  @moduletag :parity
  @moduletag timeout: 15_000

  @fixed_prompts [
    "What is 2 + 2?",
    "Summarize the concept of idempotency in one sentence.",
    "List three prime numbers.",
    "Translate 'hello' into French.",
    "What is the capital of Austria?"
  ]

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
      flunk("sidecar script not found: #{sidecar_script}")
    end

    node = System.find_executable("node") || flunk("node not on PATH")
    {:ok, %{node: node, script: sidecar_script}}
  end

  test "sidecar run is deterministic for each prompt (5 prompts)", ctx do
    for prompt <- @fixed_prompts do
      run_a = sidecar_once(ctx, prompt)
      run_b = sidecar_once(ctx, prompt)

      diff = compare_runs(run_a, run_b)

      assert diff == [],
             """
             prompt: #{inspect(prompt)}
             run_a:  #{inspect(run_a)}
             run_b:  #{inspect(run_b)}
             diff:   #{inspect(diff, pretty: true)}
             """
    end
  end

  @tag :pending_cli_transport
  test "CLI vs sidecar parity placeholder — deferred until CLI compiles on main" do
    # Intentionally left as a named placeholder: once
    # lib/claude_agent_sdk/query/cli_stream.ex stops referencing the
    # missing ExternalRuntimeTransport module, add the CLI run here and
    # compare via `compare_runs/2`.
    assert true
  end

  # --- helpers --------------------------------------------------------------

  defp sidecar_once(%{node: node, script: script}, prompt) do
    runtime =
      Runtime.new(
        node_binary: node,
        sidecar_script: script,
        env: %{"PATH" => System.get_env("PATH"), "SIDECAR_MOCK" => "1"}
      )

    {:ok, worker} = GenServer.start(Worker, runtime: runtime)

    try do
      Worker.subscribe(worker)

      receive do
        {:sidecar_ready, _} -> :ok
      after
        5_000 -> flunk("no sidecar.ready")
      end

      {:ok, session} = GenServer.start(SidecarSession, worker: worker, registry: nil)
      SidecarSession.subscribe(session)
      {:ok, sid} = SidecarSession.create(session)
      :ok = SidecarSession.send_message(session, prompt)
      {:ok, _} = SidecarSession.start_stream(session)

      ctx = drain_stream(sid, 1_500)
      :ok = SidecarSession.close(session)
      ctx
    after
      if Process.alive?(worker), do: Process.exit(worker, :shutdown)
    end
  end

  defp drain_stream(sid, window_ms) do
    deadline = System.monotonic_time(:millisecond) + window_ms
    collect(sid, %{messages: [], ended?: false}, deadline)
  end

  defp collect(_sid, %{ended?: true} = acc, _deadline), do: finalize(acc)

  defp collect(sid, acc, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:stream_message, ^sid, %{"message" => msg}} ->
        collect(sid, %{acc | messages: [msg | acc.messages]}, deadline)

      {:stream_end, ^sid, _} ->
        collect(sid, %{acc | ended?: true}, deadline)

      _ ->
        collect(sid, acc, deadline)
    after
      remaining -> finalize(acc)
    end
  end

  defp finalize(%{messages: msgs}) do
    msgs
    |> Enum.reverse()
    |> Enum.map(&normalize/1)
  end

  @doc """
  Normalization keeps the message's *semantic* payload and drops fields
  that legitimately differ across runs (timestamps, stream ids, request
  ids, trace ids). When the CLI leg comes online, add its analogous
  keys here.
  """
  def normalize(msg) when is_map(msg) do
    msg
    |> Map.drop([
      "timestamp",
      "createdAt",
      "stream_id",
      "streamId",
      "request_id",
      "traceId",
      "span_id"
    ])
    |> Map.new(fn {k, v} -> {k, normalize(v)} end)
  end

  def normalize(list) when is_list(list), do: Enum.map(list, &normalize/1)
  def normalize(other), do: other

  defp compare_runs(a, b) when length(a) != length(b),
    do: [{:length_mismatch, length(a), length(b)}]

  defp compare_runs(a, b) do
    a
    |> Enum.zip(b)
    |> Enum.with_index()
    |> Enum.flat_map(fn {{ma, mb}, idx} ->
      if ma == mb, do: [], else: [{:mismatch_at, idx, ma, mb}]
    end)
  end
end
