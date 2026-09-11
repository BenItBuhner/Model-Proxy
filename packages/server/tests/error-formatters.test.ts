import { describe, expect, test } from "bun:test";
import {
  formatAnthropicUpstreamError,
  formatOpenAIUpstreamError,
  isContextOverflowMessage,
} from "../src/server/error-formatters.ts";

describe("isContextOverflowMessage", () => {
  test("matches provider-specific overflow wordings", () => {
    expect(isContextOverflowMessage(
      "This model's maximum context length is 200000 tokens. However, you requested 250000 tokens",
    )).toBe(true);
    expect(isContextOverflowMessage("prompt is too long: 250000 tokens > 200000 maximum")).toBe(true);
    expect(isContextOverflowMessage("The input token count (1200000) exceeds the maximum number of tokens allowed (1000000).")).toBe(true);
    expect(isContextOverflowMessage("Request too large: token limit exceeded")).toBe(true);
    expect(isContextOverflowMessage("input length and `max_tokens` exceed context limit")).toBe(true);
  });

  test("does not match unrelated errors", () => {
    expect(isContextOverflowMessage("Invalid API key provided")).toBe(false);
    expect(isContextOverflowMessage("rate limit exceeded, retry after 30s")).toBe(false);
    expect(isContextOverflowMessage("upstream connect error")).toBe(false);
  });
});

describe("formatOpenAIUpstreamError", () => {
  test("normalizes overflow errors to 400 context_length_exceeded", () => {
    const payload = formatOpenAIUpstreamError(413, "prompt is too long: 250000 tokens > 200000 maximum") as {
      error: { message: string; type: string; code: string };
    };
    expect(payload.error.code).toBe("context_length_exceeded");
    expect(payload.error.type).toBe("invalid_request_error");
    expect(payload.error.message).toContain("prompt is too long");
  });

  test("passes non-overflow errors through unchanged", () => {
    const payload = formatOpenAIUpstreamError(502, "Provider zai/glm failed: bad gateway") as {
      error: { message: string; type: string; code: string | null };
    };
    expect(payload.error.type).toBe("bad_gateway");
    expect(payload.error.code).toBeNull();
  });
});

describe("formatAnthropicUpstreamError", () => {
  test("normalizes overflow errors to 400 invalid_request_error", () => {
    const payload = formatAnthropicUpstreamError(503, "maximum context length exceeded") as {
      type: string;
      error: { type: string; message: string };
    };
    expect(payload.type).toBe("error");
    expect(payload.error.type).toBe("invalid_request_error");
    expect(payload.error.message).toContain("maximum context length");
  });

  test("passes non-overflow errors through unchanged", () => {
    const payload = formatAnthropicUpstreamError(504, "upstream timed out") as {
      error: { type: string };
    };
    expect(payload.error.type).toBe("gateway_timeout");
  });
});
