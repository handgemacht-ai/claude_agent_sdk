defmodule ClaudeAgentSDK.JsonRpc.ProtocolParityTest do
  @moduledoc """
  Enforces the acceptance criterion on orchestra-cct:

    > CI check: every TS method const has an Elixir counterpart.

  Reads `priv/ts_sidecar/src/protocol.ts` as text, extracts every
  `METHOD_*` / `NOTIF_*` string-constant declaration, and asserts that
  each value appears in `Protocol.methods() ++ Protocol.notifications()`.

  The inverse direction is also checked — every Elixir-side method or
  notification must appear in protocol.ts — so drift in either
  direction fails the test.
  """

  use ExUnit.Case, async: true

  alias ClaudeAgentSDK.JsonRpc.Protocol

  @ts_path Path.join([
             File.cwd!(),
             "priv",
             "ts_sidecar",
             "src",
             "protocol.ts"
           ])

  test "protocol.ts exists at the expected path" do
    assert File.exists?(@ts_path),
           "expected #{@ts_path} — the sidecar protocol mirror"
  end

  test "every TS METHOD_* constant has an Elixir method counterpart" do
    ts_methods = extract_ts_constants(@ts_path, "METHOD_")
    elixir_methods = MapSet.new(Protocol.methods())

    missing =
      ts_methods
      |> Enum.reject(&MapSet.member?(elixir_methods, &1))

    assert missing == [],
           """
           Methods declared in protocol.ts but missing from protocol.ex:
           #{inspect(missing, pretty: true)}

           Add them to Protocol.methods/0 with matching payload typespecs.
           """
  end

  test "every TS NOTIF_* constant has an Elixir notification counterpart" do
    ts_notifs = extract_ts_constants(@ts_path, "NOTIF_")
    elixir_notifs = MapSet.new(Protocol.notifications())

    missing =
      ts_notifs
      |> Enum.reject(&MapSet.member?(elixir_notifs, &1))

    assert missing == [],
           """
           Notifications declared in protocol.ts but missing from protocol.ex:
           #{inspect(missing, pretty: true)}

           Add them to Protocol.notifications/0 with matching payload typespecs.
           """
  end

  test "every Elixir method appears in protocol.ts" do
    ts_methods = MapSet.new(extract_ts_constants(@ts_path, "METHOD_"))
    missing = Enum.reject(Protocol.methods(), &MapSet.member?(ts_methods, &1))

    assert missing == [],
           """
           Methods in protocol.ex but missing from protocol.ts:
           #{inspect(missing, pretty: true)}

           Mirror them as METHOD_* string constants in priv/ts_sidecar/src/protocol.ts.
           """
  end

  test "every Elixir notification appears in protocol.ts" do
    ts_notifs = MapSet.new(extract_ts_constants(@ts_path, "NOTIF_"))
    missing = Enum.reject(Protocol.notifications(), &MapSet.member?(ts_notifs, &1))

    assert missing == [],
           """
           Notifications in protocol.ex but missing from protocol.ts:
           #{inspect(missing, pretty: true)}

           Mirror them as NOTIF_* string constants in priv/ts_sidecar/src/protocol.ts.
           """
  end

  test "protocol version string matches on both sides" do
    source = File.read!(@ts_path)

    [[_, ts_version]] =
      Regex.scan(~r/export\s+const\s+PROTOCOL_VERSION\s*=\s*"([^"]+)"/, source)

    assert ts_version == Protocol.protocol_version(),
           "PROTOCOL_VERSION mismatch: ts=#{ts_version} elixir=#{Protocol.protocol_version()}"
  end

  test "error codes match on both sides" do
    ts_errors = extract_ts_error_codes(@ts_path)
    elixir_errors = Protocol.error_codes() |> Map.new(fn {k, v} -> {Atom.to_string(k), v} end)

    only_in_ts = Map.drop(ts_errors, Map.keys(elixir_errors))
    only_in_elixir = Map.drop(elixir_errors, Map.keys(ts_errors))

    value_diffs =
      for {k, v} <- ts_errors,
          Map.has_key?(elixir_errors, k),
          elixir_errors[k] != v,
          do: {k, ts: v, elixir: elixir_errors[k]}

    assert only_in_ts == %{} and only_in_elixir == %{} and value_diffs == [],
           """
           Error code drift between protocol.ts and protocol.ex:
             only in TS:     #{inspect(only_in_ts)}
             only in Elixir: #{inspect(only_in_elixir)}
             value diffs:    #{inspect(value_diffs)}
           """
  end

  # --- helpers --------------------------------------------------------------

  defp extract_ts_constants(path, prefix) do
    source = File.read!(path)

    pattern =
      Regex.compile!("export\\s+const\\s+" <> prefix <> "[A-Z0-9_]+\\s*=\\s*\"([^\"]+)\"")

    pattern
    |> Regex.scan(source)
    |> Enum.map(fn [_, value] -> value end)
  end

  defp extract_ts_error_codes(path) do
    source = File.read!(path)

    ~r/export\s+const\s+ERROR_([A-Z_]+)\s*=\s*(-?\d+)/
    |> Regex.scan(source)
    |> Map.new(fn [_, name, value] ->
      {String.downcase(name), String.to_integer(value)}
    end)
  end
end
