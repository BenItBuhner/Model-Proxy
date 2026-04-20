import { describe, expect, test } from "bun:test";

import {
  fixMissingToolResponsesOpenAI,
  fixMissingToolResultsAnthropic,
} from "../src/routing/tool-response-fixer.ts";

describe("fixMissingToolResponsesOpenAI", () => {
  test("injects empty tool messages for missing tool_call_ids", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "t2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "user", content: "follow-up" },
      ],
    };
    const fixed = fixMissingToolResponsesOpenAI(input);
    const messages = fixed["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["role"]).toBe("assistant");
    expect(messages[1]?.["role"]).toBe("tool");
    expect(messages[1]?.["tool_call_id"]).toBe("t1");
    expect(messages[2]?.["role"]).toBe("tool");
    expect(messages[2]?.["tool_call_id"]).toBe("t2");
    expect(messages[3]?.["role"]).toBe("user");
  });

  test("does nothing when responses are already present", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "a", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "done" },
      ],
    };
    const fixed = fixMissingToolResponsesOpenAI(input);
    expect(fixed["messages"]).toEqual(input.messages);
  });
});

describe("fixMissingToolResultsAnthropic", () => {
  test("injects tool_result blocks before the next user turn", () => {
    const input = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "a", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "follow-up" }],
        },
      ],
    };
    const fixed = fixMissingToolResultsAnthropic(input);
    const messages = fixed["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(3);
    const injected = messages[1];
    expect(injected?.["role"]).toBe("user");
    const content = injected?.["content"] as Array<Record<string, unknown>>;
    expect(content[0]?.["type"]).toBe("tool_result");
    expect(content[0]?.["tool_use_id"]).toBe("t1");
  });
});
