import { describe, expect, test } from "bun:test";

import { openaiToResponsesRequest } from "../src/routing/executor.ts";

describe("openaiToResponsesRequest reasoning mapping", () => {
  const base = {
    model: "m",
    messages: [{ role: "user", content: "hi" }],
  };

  test("forwards a reasoning object unchanged", () => {
    const result = openaiToResponsesRequest({
      ...base,
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(result["reasoning"]).toEqual({ effort: "high", summary: "auto" });
  });

  test("wraps a bare reasoning_effort string into reasoning.effort", () => {
    const result = openaiToResponsesRequest({ ...base, reasoning_effort: "medium" });
    expect(result["reasoning"]).toEqual({ effort: "medium" });
  });

  test("prefers the reasoning object when both fields are present", () => {
    const result = openaiToResponsesRequest({
      ...base,
      reasoning: { effort: "low" },
      reasoning_effort: "high",
    });
    expect(result["reasoning"]).toEqual({ effort: "low" });
  });

  test("omits reasoning when neither field is present", () => {
    const result = openaiToResponsesRequest(base);
    expect("reasoning" in result).toBe(false);
  });
});
