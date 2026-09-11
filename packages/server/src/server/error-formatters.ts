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

/**
 * Matches upstream context-window overflow errors across providers (OpenAI
 * "maximum context length", Anthropic "prompt is too long", Gemini "input
 * token count", vLLM/Groq variants). Clients like Cursor only trigger their
 * compaction/summarization flow when the failure is recognizable as a
 * context overflow, so these are re-shaped to the canonical client form.
 */
const CONTEXT_OVERFLOW_PATTERN =
  /context[\s_-]*(length|window)|prompt is too long|prompt too long|input is too long|too many (input|total|prompt|context) tokens|token limit|input token count|maximum context|max_prompt_tokens|exceed context limit|request too large|request_too_large/i;

export function isContextOverflowMessage(message: string): boolean {
  return CONTEXT_OVERFLOW_PATTERN.test(message);
}

/**
 * Format an error derived from an upstream failure for OpenAI clients.
 * Context-overflow errors are normalized to 400 + `context_length_exceeded`
 * (OpenAI's canonical shape) regardless of the upstream status or wording.
 */
export function formatOpenAIUpstreamError(
  status: number,
  message: string,
  type?: string,
): Record<string, unknown> {
  if (isContextOverflowMessage(message)) {
    return formatOpenAIError(400, message, "invalid_request_error", "context_length_exceeded");
  }
  return formatOpenAIError(status, message, type);
}

/** Anthropic-protocol counterpart: overflow maps to 400 invalid_request_error. */
export function formatAnthropicUpstreamError(
  status: number,
  message: string,
  type?: string,
): Record<string, unknown> {
  if (isContextOverflowMessage(message)) {
    return formatAnthropicError(400, message, "invalid_request_error");
  }
  return formatAnthropicError(status, message, type);
}

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
