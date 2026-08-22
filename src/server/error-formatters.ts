/** Error response shapes for OpenAI and Anthropic wire protocols. */

const STATUS_TYPE_MAP: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  422: "invalid_request_error",
  429: "rate_limit_error",
  500: "internal_server_error",
  502: "bad_gateway",
  503: "service_unavailable",
  504: "gateway_timeout",
};

export function formatOpenAIError(
  status: number,
  message: string,
  type?: string,
  code?: string,
): Record<string, unknown> {
  return {
    error: {
      message,
      type: type ?? STATUS_TYPE_MAP[status] ?? "api_error",
      code: code ?? null,
    },
  };
}

export function formatAnthropicError(
  status: number,
  message: string,
  type?: string,
): Record<string, unknown> {
  const finalType =
    type ?? STATUS_TYPE_MAP[status] ?? (status >= 500 ? "api_error" : "invalid_request_error");
  return {
    type: "error",
    error: {
      type: finalType,
      message,
    },
  };
}
