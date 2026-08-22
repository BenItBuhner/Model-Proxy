import { describe, expect, test } from "bun:test";

import {
  analyzeRequestForRouting,
  hasMultimodalContent,
} from "../src/routing/request-analysis.ts";

describe("routing request analysis", () => {
  test("detects OpenAI image_url message content", () => {
    expect(
      hasMultimodalContent({
        model: "general",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("detects Anthropic image message content", () => {
    expect(
      hasMultimodalContent({
        model: "general",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "abc",
                },
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("does not treat tool schemas as multimodal content", () => {
    expect(
      hasMultimodalContent({
        model: "general",
        messages: [{ role: "user", content: "hi" }],
        tools: [
          {
            type: "function",
            function: {
              name: "classify",
              parameters: {
                type: "object",
                properties: {
                  kind: { type: "image" },
                },
              },
            },
          },
        ],
      }),
    ).toBe(false);
  });

  test("returns a prompt token estimate", () => {
    const analysis = analyzeRequestForRouting({
      model: "general",
      messages: [{ role: "user", content: "hello world" }],
    });
    expect(analysis.hasMultimodalContent).toBe(false);
    expect(analysis.estimatedPromptTokens).toBeGreaterThan(0);
  });
});
