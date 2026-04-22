defmodule Mix.Tasks.Compile.ClaudeAgentSdkSidecar do
  @shortdoc "Ensures TS sidecar Node deps are installed (priv/ts_sidecar)"

  @moduledoc """
  Mix compiler step that ensures the TS sidecar's Node dependencies are
  installed in `priv/ts_sidecar/`.

  Idempotent — skips when the expected packages are already present. When
  missing, delegates to `mix claude_agent_sdk.install_sidecar`, which
  verifies Node >= 20 and runs `npm ci` against the committed lockfile.

  Wired into the SDK's `compilers:` list so that consumer applications
  pick up the sidecar automatically during `mix deps.compile`.
  """

  use Mix.Task.Compiler

  @sidecar_subpath "priv/ts_sidecar"

  @required_packages [
    ["zod", "package.json"],
    ["@anthropic-ai", "claude-agent-sdk", "package.json"]
  ]

  @impl Mix.Task.Compiler
  def run(_args) do
    sidecar_dir = Path.join(File.cwd!(), @sidecar_subpath)

    cond do
      not File.dir?(sidecar_dir) ->
        {:noop, []}

      sidecar_installed?(sidecar_dir) ->
        {:noop, []}

      true ->
        Mix.Task.run("claude_agent_sdk.install_sidecar")
        {:ok, []}
    end
  end

  @impl Mix.Task.Compiler
  def manifests, do: []

  @impl Mix.Task.Compiler
  def clean, do: :ok

  defp sidecar_installed?(sidecar_dir) do
    Enum.all?(@required_packages, fn parts ->
      File.exists?(Path.join([sidecar_dir, "node_modules" | parts]))
    end)
  end
end
