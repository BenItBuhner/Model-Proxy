import { describe, expect, test } from "bun:test";

import {
  scrubRetryMarkers,
  withRetryCorrection,
} from "../src/routing/enforce/retry.ts";

describe("withRetryCorrection", () => {
  test("does not mutate the input request", () => {
    const original = {
      messages: [{ role: "user", content: "hi" }],
    };
    const originalJson = JSON.stringify(original);
    withRetryCorrection(original, "bad output", "openai");
    expect(JSON.stringify(original)).toBe(originalJson);
  });

  test("appends one retry user message (OpenAI)", () => {
    const out = withRetryCorrection(
      { messages: [{ role: "user", content: "hi" }] },
      "bad",
      "openai",
    );
    const messages = out["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages[1]?.["role"]).toBe("user");
    expect(String(messages[1]?.["content"]).toLowerCase()).toContain("proxy retry");
  });

  test("strips previous retry messages before appending (no context bloat)", () => {
    const first = withRetryCorrection(
      { messages: [{ role: "user", content: "hi" }] },
      "reason 1",
      "openai",
    );
    const second = withRetryCorrection(first, "reason 2", "openai");
    const messages = second["messages"] as Array<Record<string, unknown>>;
    // After two rounds: original user + exactly ONE retry message (the new one).
    expect(messages.length).toBe(2);
    expect(String(messages[1]?.["content"])).toContain("reason 2");
    expect(String(messages[1]?.["content"])).not.toContain("reason 1");
  });

  test("Anthropic retry message uses content block array", () => {
    const out = withRetryCorrection(
      { messages: [{ role: "user", content: "hi" }] },
      "bad",
      "anthropic",
    );
    const messages = out["messages"] as Array<Record<string, unknown>>;
    const last = messages[messages.length - 1];
    const content = last?.["content"] as Array<Record<string, unknown>>;
    expect(content[0]?.["type"]).toBe("text");
  });
});

describe("scrubRetryMarkers", () => {
  test("removes the internal marker key from retry messages before dispatch", () => {
    const withRetry = withRetryCorrection(
      { messages: [{ role: "user", content: "hi" }] },
      "reason",
      "openai",
    );
    const scrubbed = scrubRetryMarkers(withRetry);
    const messages = scrubbed["messages"] as Array<Record<string, unknown>>;
    for (const msg of messages) {
      expect("__mp_enforce_retry" in msg).toBe(false);
    }
  });
});
