import { describe, expect, test } from "bun:test";

import {
  responseContainsFlag,
  stripTerminationFlag,
} from "../src/routing/enforce/stripper.ts";

const FLAG = '{"tool_loop":"completed"}';

describe("stripTerminationFlag (OpenAI)", () => {
  test("strips flag from string content, keeps the trimmed remainder", () => {
    const out = stripTerminationFlag(
      {
        choices: [
          {
            message: { role: "assistant", content: `Here is your answer. ${FLAG}` },
            finish_reason: "stop",
          },
        ],
      },
      FLAG,
      "openai",
    );
    const msg = (out["choices"] as Array<Record<string, unknown>>)[0]?.[
      "message"
    ] as Record<string, unknown>;
    expect(msg["content"]).toBe("Here is your answer.");
  });

  test("flag-only content + no tool_calls → content becomes null + finish_reason stop (regression)", () => {
    const out = stripTerminationFlag(
      {
        choices: [
          {
            message: { role: "assistant", content: FLAG },
            finish_reason: "stop",
          },
        ],
      },
      FLAG,
      "openai",
    );
    const choice = (out["choices"] as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    const msg = choice["message"] as Record<string, unknown>;
    expect(msg["content"]).toBeNull();
    expect(choice["finish_reason"]).toBe("stop");
  });

  test("preserves tool_calls untouched", () => {
    const toolCall = {
      id: "t1",
      type: "function",
      function: { name: "fn", arguments: '{"a":1}' },
    };
    const out = stripTerminationFlag(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: FLAG,
              tool_calls: [toolCall],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      FLAG,
      "openai",
    );
    const msg = (out["choices"] as Array<Record<string, unknown>>)[0]?.[
      "message"
    ] as Record<string, unknown>;
    const toolCalls = msg["tool_calls"] as Array<Record<string, unknown>>;
    expect(toolCalls[0]).toEqual(toolCall);
  });

  test("strips from array content text parts", () => {
    const out = stripTerminationFlag(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: `Done. ${FLAG}` },
              ],
            },
          },
        ],
      },
      FLAG,
      "openai",
    );
    const msg = (out["choices"] as Array<Record<string, unknown>>)[0]?.[
      "message"
    ] as Record<string, unknown>;
    const arr = msg["content"] as Array<Record<string, unknown>>;
    expect(arr[0]?.["text"]).toBe("Done.");
  });
});

describe("stripTerminationFlag (Anthropic)", () => {
  test("removes flag from text block and collapses when empty", () => {
    const out = stripTerminationFlag(
      {
        content: [
          { type: "text", text: FLAG },
          { type: "text", text: "Real answer." },
        ],
        stop_reason: "end_turn",
      },
      FLAG,
      "anthropic",
    );
    const blocks = out["content"] as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.["text"]).toBe("Real answer.");
  });

  test("sets stop_reason end_turn when only termination flag was present", () => {
    const out = stripTerminationFlag(
      {
        content: [{ type: "text", text: FLAG }],
        stop_reason: "end_turn",
      },
      FLAG,
      "anthropic",
    );
    expect(out["stop_reason"]).toBe("end_turn");
    const blocks = out["content"] as Array<Record<string, unknown>>;
    expect(blocks.length).toBe(0);
  });
});

describe("responseContainsFlag", () => {
  test("detects OpenAI nested flag", () => {
    expect(
      responseContainsFlag(
        {
          choices: [
            { message: { content: `answer ${FLAG}` } },
          ],
        },
        FLAG,
        "openai",
      ),
    ).toBe(true);
  });

  test("detects Anthropic top-level string", () => {
    expect(responseContainsFlag({ content: FLAG }, FLAG, "anthropic")).toBe(true);
  });
});
