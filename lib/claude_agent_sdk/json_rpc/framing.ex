defmodule ClaudeAgentSDK.JsonRpc.Framing do
  @moduledoc """
  Encode/decode JSON-RPC 2.0 frames for the sidecar protocol.

  One JSON object per `\\n`-terminated line on stdio. Stdout carries
  frames only; stderr is unstructured and never parsed here.
  """

  @typedoc "Decoded envelope: request, notification, success, or error."
  @type frame ::
          {:request, id :: term(), method :: String.t(), params :: map()}
          | {:notification, method :: String.t(), params :: map()}
          | {:response_ok, id :: term(), result :: any()}
          | {:response_error, id :: term(), code :: integer(), message :: String.t(),
             data :: any()}

  @jsonrpc "2.0"

  @spec encode_request(term(), String.t(), map()) :: iodata()
  def encode_request(id, method, params) do
    line(%{jsonrpc: @jsonrpc, id: id, method: method, params: params})
  end

  @spec encode_notification(String.t(), map()) :: iodata()
  def encode_notification(method, params) do
    line(%{jsonrpc: @jsonrpc, method: method, params: params})
  end

  @spec encode_response(term(), any()) :: iodata()
  def encode_response(id, result) do
    line(%{jsonrpc: @jsonrpc, id: id, result: result})
  end

  @spec encode_error(term(), integer(), String.t(), any()) :: iodata()
  def encode_error(id, code, message, data \\ nil) do
    err = %{code: code, message: message}
    err = if is_nil(data), do: err, else: Map.put(err, :data, data)
    line(%{jsonrpc: @jsonrpc, id: id, error: err})
  end

  @spec decode(binary()) :: {:ok, frame()} | {:error, term()}
  def decode(line) when is_binary(line) do
    case Jason.decode(line) do
      {:ok, %{"jsonrpc" => @jsonrpc} = m} -> classify(m)
      {:ok, _} -> {:error, :missing_jsonrpc}
      {:error, reason} -> {:error, {:parse, reason}}
    end
  end

  defp classify(%{"id" => id, "method" => method} = m),
    do: {:ok, {:request, id, method, Map.get(m, "params", %{})}}

  defp classify(%{"method" => method} = m),
    do: {:ok, {:notification, method, Map.get(m, "params", %{})}}

  defp classify(%{"id" => id, "result" => result}),
    do: {:ok, {:response_ok, id, result}}

  defp classify(%{"id" => id, "error" => %{"code" => code, "message" => msg} = err}),
    do: {:ok, {:response_error, id, code, msg, Map.get(err, "data")}}

  defp classify(_), do: {:error, :unclassified}

  defp line(map), do: [Jason.encode_to_iodata!(map), ?\n]
end
