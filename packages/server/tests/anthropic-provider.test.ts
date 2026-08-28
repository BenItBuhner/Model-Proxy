import { describe, expect, test } from "bun:test";

import { AnthropicProvider } from "../src/providers/anthropic-provider.ts";

describe("AnthropicProvider buildPayload", () => {
  const provider = new AnthropicProvider("anthropic");

  test("forwards thinking to the upstream payload", () => {
    const payload = provider["buildPayload"]({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 17408,
      thinking: { type: "enabled", budget_tokens: 16384 },
    });
    expect(payload["thinking"]).toEqual({ type: "enabled", budget_tokens: 16384 });
    expect(payload["max_tokens"]).toBe(17408);
  });

  test("omits thinking when not provided", () => {
    const payload = provider["buildPayload"]({
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1024,
    });
    expect("thinking" in payload).toBe(false);
  });
});
