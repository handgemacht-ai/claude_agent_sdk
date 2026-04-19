defmodule Mix.Tasks.ClaudeAgentSdk.InstallSidecar do
  @shortdoc "Installs Node dependencies for the TS sidecar (priv/ts_sidecar)"

  @moduledoc """
  Installs the sidecar's Node dependencies.

  Must be runnable in CI without interactive prompts. Fails loudly when
  prerequisites are missing — no silent skips, matches the workspace
  `fail fast if configuration missing` rule.

  Steps:

    1. Verify `node` is on PATH.
    2. Verify its major version is >= 20 (required by the V2 preview's
       `await using` syntax).
    3. Run `npm ci` in `priv/ts_sidecar/` using the committed
       `package-lock.json`.
    4. Verify `dist/index.js` exists (committed output; rebuilt
       separately via `npm run build`).

  Called from `mix.exs` compile aliases. Safe to re-run.
  """

  use Mix.Task

  @sidecar_subpath "priv/ts_sidecar"
  @min_node_major 20

  @impl Mix.Task
  def run(_args) do
    sidecar_dir = Path.join(app_priv_root(), @sidecar_subpath)

    unless File.dir?(sidecar_dir) do
      Mix.raise("sidecar directory missing: #{sidecar_dir}")
    end

    check_node!()
    npm_ci!(sidecar_dir)
    assert_dist!(sidecar_dir)

    Mix.shell().info("[claude_agent_sdk] sidecar installed at #{sidecar_dir}")
    :ok
  end

  defp app_priv_root do
    # Running from the SDK repo itself: cwd is repo root.
    # Running from a consumer via Mix.Project.deps_path: use that.
    File.cwd!()
  end

  defp check_node! do
    node =
      System.find_executable("node") ||
        Mix.raise("""
        node not found on $PATH.

        The claude_agent_sdk Node sidecar requires Node.js >= #{@min_node_major}.
        Install Node and ensure `node` resolves on PATH before compiling.
        """)

    {out, 0} =
      System.cmd(node, ["--version"], stderr_to_stdout: true)
      |> assert_cmd_ok("node --version")

    version = String.trim(out)

    case Regex.run(~r/^v(\d+)\./, version) do
      [_, major_str] ->
        major = String.to_integer(major_str)

        if major < @min_node_major do
          Mix.raise("""
          node #{version} too old — need >= v#{@min_node_major}.
          At `#{node}`. Upgrade and retry.
          """)
        end

      _ ->
        Mix.raise("unexpected `node --version` output: #{inspect(version)}")
    end
  end

  defp npm_ci!(sidecar_dir) do
    npm =
      System.find_executable("npm") ||
        Mix.raise("npm not found on $PATH (installed with Node usually)")

    Mix.shell().info("[claude_agent_sdk] running `npm ci` in #{sidecar_dir}")

    {_out, 0} =
      System.cmd(npm, ["ci", "--no-audit", "--no-fund"],
        cd: sidecar_dir,
        stderr_to_stdout: true,
        into: IO.stream(:stdio, :line)
      )
      |> assert_cmd_ok("npm ci")
  end

  defp assert_dist!(sidecar_dir) do
    dist_entry = Path.join([sidecar_dir, "dist", "index.js"])

    unless File.exists?(dist_entry) do
      Mix.raise("""
      sidecar dist missing: #{dist_entry}

      Rebuild via `cd #{sidecar_dir} && npm run build` and commit the
      output. Committing dist/ is deliberate — consumers shouldn't need
      tsc at install time.
      """)
    end
  end

  defp assert_cmd_ok({out, 0}, _label), do: {out, 0}

  defp assert_cmd_ok({out, code}, label) do
    Mix.raise("""
    `#{label}` failed with exit status #{code}:

    #{if is_binary(out), do: out, else: ""}
    """)
  end
end
