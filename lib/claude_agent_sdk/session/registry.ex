defmodule ClaudeAgentSDK.Session.Registry do
  @moduledoc """
  `Registry` keyed by `sessionId`. Thin wrapper so callers can look up a
  `Session` GenServer from a demultiplexed `sessionId` string.
  """

  @doc "Default name used when the SDK application tree starts one."
  def name, do: __MODULE__

  def child_spec(opts) do
    name = Keyword.get(opts, :name, name())

    %{
      id: name,
      start: {Registry, :start_link, [[keys: :unique, name: name]]},
      type: :supervisor
    }
  end

  def register(registry \\ name(), session_id, pid \\ self()) do
    Registry.register(registry, session_id, pid)
  end

  def lookup(registry \\ name(), session_id) do
    case Registry.lookup(registry, session_id) do
      [{pid, _}] -> {:ok, pid}
      [] -> :error
    end
  end
end
