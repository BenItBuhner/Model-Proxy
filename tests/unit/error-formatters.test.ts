import { describe, test, expect } from "bun:test";
import {
  formatOpenaiError,
  formatAnthropicError,
  formatResponsesError,
  formatGenaiError,
  formatError,
} from "../../src/core/error-formatters.ts";

describe("Error Formatters", () => {
  test("formatOpenaiError returns correct structure", () => {
    const result = formatOpenaiError(401, "Invalid key");
    expect(result.error).toBeDefined();
    expect(result.error.message).toBe("Invalid key");
    expect(result.error.type).toBe("authentication_error");
  });

  test("formatAnthropicError returns correct structure", () => {
    const result = formatAnthropicError(429, "Rate limited");
    expect(result.error.message).toBe("Rate limited");
    expect(result.error.type).toBe("rate_limit_error");
  });

  test("formatResponsesError returns correct structure", () => {
    const result = formatResponsesError(500, "Server error");
    expect(result.error.message).toBe("Server error");
    expect(result.error.type).toBe("internal_server_error");
  });

  test("formatGenaiError returns correct structure", () => {
    const result = formatGenaiError(503, "Service down");
    expect(result.error.code).toBe(503);
    expect(result.error.message).toBe("Service down");
  });

  test("formatError dispatches correctly", () => {
    const openai = formatError("openai", 400, "Bad request");
    expect(openai.error.type).toBe("invalid_request_error");

    const anthropic = formatError("anthropic", 404, "Not found");
    expect(anthropic.error.type).toBe("not_found_error");
  });
});
