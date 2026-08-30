import { describe, expect, it } from "bun:test";
import { buildRequestBody } from "../lib/test-payload";
import type { ParamState } from "../lib/test-session";

function baseParams(overrides: Partial<ParamState> = {}): ParamState {
  return { stream: false, enforceOverride: "default", ...overrides };
}

const messages = [{ role: "user" as const, content: "hi" }];

describe("test payload reasoning effort", () => {
  it("includes reasoning_effort in OpenAI bodies when set", () => {
    const body = buildRequestBody(
      "openai",
      baseParams({ reasoning_effort: "high" }),
      messages,
      [],
      "gpt-test",
    );
    expect(body["reasoning_effort"]).toBe("high");
  });

  it("omits reasoning_effort from OpenAI bodies when unset", () => {
    const body = buildRequestBody("openai", baseParams(), messages, [], "gpt-test");
    expect("reasoning_effort" in body).toBe(false);
  });

  it("maps reasoning_effort to thinking in Anthropic bodies", () => {
    const body = buildRequestBody(
      "anthropic",
      baseParams({ reasoning_effort: "medium", max_tokens: 4096 }),
      messages,
      [],
      "claude-test",
    );
    expect(body["thinking"]).toEqual({ type: "enabled", budget_tokens: 4095 });
  });

  it("drops thinking when max_tokens cannot fit the budget", () => {
    const body = buildRequestBody(
      "anthropic",
      baseParams({ reasoning_effort: "high", max_tokens: 256 }),
      messages,
      [],
      "claude-test",
    );
    expect("thinking" in body).toBe(false);
  });

  it("omits thinking from Anthropic bodies when unset", () => {
    const body = buildRequestBody(
      "anthropic",
      baseParams({ max_tokens: 1024 }),
      messages,
      [],
      "claude-test",
    );
    expect("thinking" in body).toBe(false);
  });
});
