defmodule ClaudeAgentSDK.Options.Runtime do
  @moduledoc """
  Explicit runtime configuration for the Node sidecar transport.

  Every field is required in spirit: there is no ambient lookup of
  `node` on `$PATH`, no silent inheritance of `System.get_env/0`. A
  misconfigured `Runtime` fails at `Sidecar.Worker` boot with a clear
  error, not at the first `query/2` call.

  Honors `feedback_sdk_explicitness.md`: callers pass what the sidecar
  sees, verbatim.
  """

  @enforce_keys [:node_binary, :sidecar_script]
  defstruct [
    :node_binary,
    :sidecar_script,
    :working_directory,
    env: %{},
    spawn_timeout_ms: 10_000,
    shutdown_timeout_ms: 5_000,
    pool_size: 1,
    resume_on_sidecar_restart: false,
    mock: false
  ]

  @type t :: %__MODULE__{
          node_binary: String.t(),
          sidecar_script: String.t(),
          env: %{optional(String.t()) => String.t()},
          working_directory: String.t() | nil,
          spawn_timeout_ms: non_neg_integer(),
          shutdown_timeout_ms: non_neg_integer(),
          pool_size: pos_integer(),
          resume_on_sidecar_restart: boolean(),
          mock: boolean()
        }

  @doc """
  Build a `%Runtime{}` with the given overrides.

  `node_binary` and `sidecar_script` are required — no lookup.
  """
  @spec new(keyword() | map()) :: t()
  def new(opts) do
    opts = Enum.into(opts, %{})

    missing =
      [:node_binary, :sidecar_script]
      |> Enum.reject(&Map.has_key?(opts, &1))

    if missing != [] do
      raise ArgumentError,
            "ClaudeAgentSDK.Options.Runtime.new/1 missing required keys: #{inspect(missing)}"
    end

    validate_paths!(opts)
    struct!(__MODULE__, opts)
  end

  defp validate_paths!(%{node_binary: nb}) when not is_binary(nb),
    do: raise(ArgumentError, "node_binary must be an absolute path string")

  defp validate_paths!(%{sidecar_script: ss}) when not is_binary(ss),
    do: raise(ArgumentError, "sidecar_script must be an absolute path string")

  defp validate_paths!(%{node_binary: nb, sidecar_script: ss}) do
    unless Path.type(nb) == :absolute do
      raise ArgumentError, "node_binary must be an absolute path, got: #{nb}"
    end

    unless Path.type(ss) == :absolute do
      raise ArgumentError, "sidecar_script must be an absolute path, got: #{ss}"
    end
  end
end
