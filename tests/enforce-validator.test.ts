import { describe, expect, test } from "bun:test";

import {
  isEmptyContentResponse,
  validateAnthropicResponse,
  validateOpenAIResponse,
} from "../src/routing/enforce/validator.ts";

const FLAG = '{"tool_loop":"completed"}';

describe("validateOpenAIResponse", () => {
  test("valid tool_calls → tool_calls", () => {
    const result = validateOpenAIResponse(
      {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "t1",
                  type: "function",
                  function: { name: "fn", arguments: "{}" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      FLAG,
    );
    expect(result.valid).toBe(true);
    expect(result.responseType).toBe("tool_calls");
  });

  test("tool_calls with missing function name → invalid", () => {
    const result = validateOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{ id: "t1", type: "function", function: {} }],
            },
          },
        ],
      },
      FLAG,
    );
    expect(result.valid).toBe(false);
  });

  test("termination flag in content → termination", () => {
    const result = validateOpenAIResponse(
      {
        choices: [
          {
            message: { role: "assistant", content: `ok, here: ${FLAG}` },
          },
        ],
      },
      FLAG,
    );
    expect(result.valid).toBe(true);
    expect(result.responseType).toBe("termination");
  });

  test("whitespace-only content with no flag → invalid (regression)", () => {
    const result = validateOpenAIResponse(
      {
        choices: [{ message: { role: "assistant", content: "   \n  " } }],
      },
      FLAG,
    );
    expect(result.valid).toBe(false);
  });

  test("null content with no tool_calls → invalid (regression)", () => {
    const result = validateOpenAIResponse(
      {
        choices: [{ message: { role: "assistant", content: null } }],
      },
      FLAG,
    );
    expect(result.valid).toBe(false);
  });

  test("array content with flag in a text part → termination", () => {
    const result = validateOpenAIResponse(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "some text" },
                { type: "text", text: FLAG },
              ],
            },
          },
        ],
      },
      FLAG,
    );
    expect(result.valid).toBe(true);
    expect(result.responseType).toBe("termination");
  });

  test("empty choices array → invalid", () => {
    const result = validateOpenAIResponse({ choices: [] }, FLAG);
    expect(result.valid).toBe(false);
  });
});

describe("validateAnthropicResponse", () => {
  test("tool_use block → tool_calls", () => {
    const result = validateAnthropicResponse(
      {
        content: [{ type: "tool_use", id: "t1", name: "fn", input: {} }],
      },
      FLAG,
    );
    expect(result.valid).toBe(true);
    expect(result.responseType).toBe("tool_calls");
  });

  test("termination flag in text block → termination", () => {
    const result = validateAnthropicResponse(
      { content: [{ type: "text", text: FLAG }] },
      FLAG,
    );
    expect(result.valid).toBe(true);
    expect(result.responseType).toBe("termination");
  });

  test("top-level string content with flag → termination", () => {
    const result = validateAnthropicResponse({ content: FLAG }, FLAG);
    expect(result.valid).toBe(true);
  });

  test("empty array content → invalid", () => {
    const result = validateAnthropicResponse({ content: [] }, FLAG);
    expect(result.valid).toBe(false);
  });

  test("whitespace-only text block → invalid", () => {
    const result = validateAnthropicResponse(
      { content: [{ type: "text", text: "   " }] },
      FLAG,
    );
    expect(result.valid).toBe(false);
  });
});

describe("isEmptyContentResponse", () => {
  test("OpenAI: null content + no tool_calls → empty", () => {
    expect(
      isEmptyContentResponse(
        { choices: [{ message: { content: null } }] },
        "openai",
      ),
    ).toBe(true);
  });

  test("OpenAI: whitespace content + no tool_calls → empty", () => {
    expect(
      isEmptyContentResponse(
        { choices: [{ message: { content: "   " } }] },
        "openai",
      ),
    ).toBe(true);
  });

  test("OpenAI: content + no tool_calls → not empty", () => {
    expect(
      isEmptyContentResponse(
        { choices: [{ message: { content: "hi" } }] },
        "openai",
      ),
    ).toBe(false);
  });

  test("OpenAI: reasoning_content with null content → not empty", () => {
    expect(
      isEmptyContentResponse(
        {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                reasoning_content: "thinking about the answer",
              },
            },
          ],
        },
        "openai",
      ),
    ).toBe(false);
  });

  test("OpenAI: tool_calls present → not empty", () => {
    expect(
      isEmptyContentResponse(
        {
          choices: [
            {
              message: {
                content: "",
                tool_calls: [
                  { id: "t1", type: "function", function: { name: "x" } },
                ],
              },
            },
          ],
        },
        "openai",
      ),
    ).toBe(false);
  });

  test("Anthropic: only whitespace text → empty", () => {
    expect(
      isEmptyContentResponse(
        { content: [{ type: "text", text: "  " }] },
        "anthropic",
      ),
    ).toBe(true);
  });

  test("Anthropic: tool_use present → not empty", () => {
    expect(
      isEmptyContentResponse(
        { content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
        "anthropic",
      ),
    ).toBe(false);
  });
});
