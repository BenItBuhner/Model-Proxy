import { describe, expect, test } from "bun:test";
import {
  asReasoningEffort,
  budgetToReasoningEffort,
  reasoningEffortFromThinking,
  thinkingFromReasoningEffort,
} from "@model-proxy/contracts/schemas/reasoning.ts";
import {
  anthropicToOpenaiRequest,
  openaiToAnthropicRequest,
} from "../src/format/converters.ts";
import { responsesRequestToChat } from "../src/format/responses.ts";
import { AnthropicProvider } from "../src/providers/anthropic-provider.ts";
import type {
  AnthropicCallArgs,
  OpenAICallArgs,
} from "../src/providers/base.ts";
import { OpenAIProvider } from "../src/providers/openai-provider.ts";

function openaiArgs(overrides: Partial<OpenAICallArgs> = {}): OpenAICallArgs {
  return {
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    ...overrides,
  };
}

function anthropicArgs(
  overrides: Partial<AnthropicCallArgs> = {},
): AnthropicCallArgs {
  return {
    model: "claude-test",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    ...overrides,
  };
}

describe("reasoning effort helpers", () => {
  test("asReasoningEffort accepts canonical values", () => {
    expect(asReasoningEffort("minimal")).toBe("minimal");
    expect(asReasoningEffort("low")).toBe("low");
    expect(asReasoningEffort("medium")).toBe("medium");
    expect(asReasoningEffort("high")).toBe("high");
  });

  test("asReasoningEffort rejects unknown values", () => {
    expect(asReasoningEffort("xhigh")).toBeUndefined();
    expect(asReasoningEffort(42)).toBeUndefined();
    expect(asReasoningEffort(undefined)).toBeUndefined();
  });

  test("thinkingFromReasoningEffort maps efforts to budgets", () => {
    expect(thinkingFromReasoningEffort("minimal")).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
    expect(thinkingFromReasoningEffort("low")).toEqual({
      type: "enabled",
      budget_tokens: 2048,
    });
    expect(thinkingFromReasoningEffort("medium")).toEqual({
      type: "enabled",
      budget_tokens: 8192,
    });
    expect(thinkingFromReasoningEffort("high")).toEqual({
      type: "enabled",
      budget_tokens: 16384,
    });
  });

  test("thinkingFromReasoningEffort clamps budget below max_tokens", () => {
    expect(thinkingFromReasoningEffort("high", 4096)).toEqual({
      type: "enabled",
      budget_tokens: 4095,
    });
  });

  test("thinkingFromReasoningEffort drops thinking when max_tokens is too small", () => {
    expect(thinkingFromReasoningEffort("low", 500)).toBeUndefined();
    expect(thinkingFromReasoningEffort("minimal", 1)).toBeUndefined();
  });

  test("budgetToReasoningEffort buckets budgets", () => {
    expect(budgetToReasoningEffort(1024)).toBe("minimal");
    expect(budgetToReasoningEffort(2048)).toBe("low");
    expect(budgetToReasoningEffort(4096)).toBe("medium");
    expect(budgetToReasoningEffort(8192)).toBe("medium");
    expect(budgetToReasoningEffort(16384)).toBe("high");
  });

  test("reasoningEffortFromThinking reads enabled thinking configs", () => {
    expect(
      reasoningEffortFromThinking({ type: "enabled", budget_tokens: 16384 }),
    ).toBe("high");
    expect(
      reasoningEffortFromThinking({ type: "enabled", budget_tokens: 4096 }),
    ).toBe("medium");
    expect(reasoningEffortFromThinking({ type: "disabled" })).toBeUndefined();
    expect(reasoningEffortFromThinking("enabled")).toBeUndefined();
    expect(
      reasoningEffortFromThinking({ type: "enabled", budget_tokens: "big" }),
    ).toBeUndefined();
  });
});

describe("OpenAIProvider buildPayload: reasoning_effort", () => {
  test("forwards reasoning_effort", () => {
    const provider = new OpenAIProvider("openai");
    const payload = provider["buildPayload"](
      openaiArgs({ reasoning_effort: "high" }),
    );
    expect(payload["reasoning_effort"]).toBe("high");
  });

  test("omits reasoning_effort when not provided", () => {
    const provider = new OpenAIProvider("openai");
    const payload = provider["buildPayload"](openaiArgs());
    expect("reasoning_effort" in payload).toBe(false);
  });

  test("forwards reasoning object alongside reasoning_effort", () => {
    const provider = new OpenAIProvider("openai");
    const payload = provider["buildPayload"](
      openaiArgs({ reasoning: { effort: "low" }, reasoning_effort: "low" }),
    );
    expect(payload["reasoning"]).toEqual({ effort: "low" });
    expect(payload["reasoning_effort"]).toBe("low");
  });
});

describe("AnthropicProvider buildPayload: thinking", () => {
  test("forwards thinking", () => {
    const provider = new AnthropicProvider();
    const thinking = { type: "enabled", budget_tokens: 2048 };
    const payload = provider["buildPayload"](anthropicArgs({ thinking }));
    expect(payload["thinking"]).toEqual(thinking);
  });

  test("omits thinking when not provided", () => {
    const provider = new AnthropicProvider();
    const payload = provider["buildPayload"](anthropicArgs());
    expect("thinking" in payload).toBe(false);
  });
});

describe("openaiToAnthropicRequest: reasoning_effort -> thinking", () => {
  test("maps reasoning_effort to thinking", () => {
    const out = openaiToAnthropicRequest({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      reasoning_effort: "medium",
    });
    expect(out["thinking"]).toEqual({ type: "enabled", budget_tokens: 4095 });
  });

  test("omits thinking when reasoning_effort is absent", () => {
    const out = openaiToAnthropicRequest({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    });
    expect("thinking" in out).toBe(false);
  });

  test("ignores unknown reasoning_effort values", () => {
    const out = openaiToAnthropicRequest({
      model: "gpt-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      reasoning_effort: "xhigh",
    });
    expect("thinking" in out).toBe(false);
  });
});

describe("anthropicToOpenaiRequest: thinking -> reasoning_effort", () => {
  test("maps enabled thinking to reasoning_effort", () => {
    const out = anthropicToOpenaiRequest({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      thinking: { type: "enabled", budget_tokens: 16384 },
    });
    expect(out["reasoning_effort"]).toBe("high");
  });

  test("ignores disabled thinking", () => {
    const out = anthropicToOpenaiRequest({
      model: "claude-test",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
      thinking: { type: "disabled" },
    });
    expect("reasoning_effort" in out).toBe(false);
  });
});

describe("responsesRequestToChat: reasoning effort extraction", () => {
  test("extracts effort from the reasoning object", () => {
    const chat = responsesRequestToChat({
      model: "gpt-test",
      input: "hi",
      reasoning: { effort: "medium" },
    });
    expect(chat["reasoning_effort"]).toBe("medium");
    expect(chat["reasoning"]).toEqual({ effort: "medium" });
  });

  test("accepts a top-level reasoning_effort", () => {
    const chat = responsesRequestToChat({
      model: "gpt-test",
      input: "hi",
      reasoning_effort: "high",
    });
    expect(chat["reasoning_effort"]).toBe("high");
  });

  test("omits reasoning_effort when not requested", () => {
    const chat = responsesRequestToChat({ model: "gpt-test", input: "hi" });
    expect("reasoning_effort" in chat).toBe(false);
  });
});
