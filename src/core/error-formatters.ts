/**
 * Error formatters for standardizing error responses to match provider formats.
 */

const ERROR_CODE_MAP: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  429: "rate_limit_error",
  500: "internal_server_error",
  502: "bad_gateway_error",
  503: "service_unavailable_error",
  504: "gateway_timeout_error",
};

export function formatOpenaiError(
  statusCode: number,
  message: string,
  errorType?: string
): Record<string, unknown> {
  return {
    error: {
      message,
      type: errorType || ERROR_CODE_MAP[statusCode] || "api_error",
      code: ERROR_CODE_MAP[statusCode] || "unknown_error",
    },
  };
}

export function formatAnthropicError(
  statusCode: number,
  message: string,
  errorType?: string
): Record<string, unknown> {
  return {
    error: {
      message,
      type: errorType || ERROR_CODE_MAP[statusCode] || "api_error",
    },
  };
}

export function formatResponsesError(
  statusCode: number,
  message: string,
  errorType?: string
): Record<string, unknown> {
  return {
    error: {
      message,
      type: errorType || ERROR_CODE_MAP[statusCode] || "api_error",
      code: ERROR_CODE_MAP[statusCode] || "unknown_error",
    },
  };
}

export function formatGenaiError(
  statusCode: number,
  message: string
): Record<string, unknown> {
  return {
    error: {
      code: statusCode,
      message,
      status: ERROR_CODE_MAP[statusCode]?.toUpperCase().replace(/_/g, " ") || "UNKNOWN",
    },
  };
}

export function formatError(
  format: "openai" | "anthropic" | "responses" | "genai",
  statusCode: number,
  message: string,
  errorType?: string
): Record<string, unknown> {
  switch (format) {
    case "openai": return formatOpenaiError(statusCode, message, errorType);
    case "anthropic": return formatAnthropicError(statusCode, message, errorType);
    case "responses": return formatResponsesError(statusCode, message, errorType);
    case "genai": return formatGenaiError(statusCode, message);
    default: return formatOpenaiError(statusCode, message, errorType);
  }
}
