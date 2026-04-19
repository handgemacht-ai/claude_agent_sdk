defmodule ClaudeAgentSDK.Sidecar.Supervisor do
  @moduledoc """
  Minimal supervision tree for the Node sidecar transport.

  Starts one `Session.Registry` and one `Sidecar.Worker`. Host apps (e.g.
  Orchestra) include this under their application supervisor.

  ## Usage

      children = [
        {ClaudeAgentSDK.Sidecar.Supervisor, runtime: my_runtime}
      ]

  `runtime` is a required `ClaudeAgentSDK.Options.Runtime` struct. Failing
  to supply one raises at startup.
  """

  use Supervisor

  alias ClaudeAgentSDK.Options.Runtime
  alias ClaudeAgentSDK.Session.Registry, as: SessionRegistry
  alias ClaudeAgentSDK.Sidecar.Worker

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    runtime = Keyword.fetch!(opts, :runtime)

    unless match?(%Runtime{}, runtime) do
      raise ArgumentError,
            "ClaudeAgentSDK.Sidecar.Supervisor expects :runtime to be %Runtime{}, got: #{inspect(runtime)}"
    end

    children = [
      SessionRegistry,
      %{
        id: Worker,
        start: {GenServer, :start_link, [Worker, [runtime: runtime], [name: Worker]]},
        restart: :permanent
      }
    ]

    Supervisor.init(children, strategy: :rest_for_one)
  end

  @doc """
  Convenience — spawns a session on the running `Sidecar.Worker`.

  Options are passed verbatim to `ClaudeAgentSDK.SidecarSession`.
  """
  def start_session(opts \\ []) do
    worker = Process.whereis(Worker) || raise "Sidecar.Worker not running"

    ClaudeAgentSDK.SidecarSession.start_link([
      {:worker, worker} | Keyword.delete(opts, :worker)
    ])
  end
end
