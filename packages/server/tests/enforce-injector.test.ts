import { describe, expect, test } from "bun:test";

import { injectGuidance } from "../src/routing/enforce/injector.ts";

const GUIDANCE = "\n\nIMPORTANT: finish with termination flag.";

describe("injectGuidance (OpenAI)", () => {
  test("appends to last system message string content", () => {
    const request = {
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hi" },
      ],
    };
    const out = injectGuidance(request, GUIDANCE, "openai");
    const messages = out["messages"] as Array<Record<string, unknown>>;
    expect(messages[0]?.["content"]).toBe("You are helpful." + GUIDANCE);
    expect(messages[1]?.["content"]).toBe("hi");
  });

  test("creates a new system message when none exists", () => {
    const request = { messages: [{ role: "user", content: "hi" }] };
    const out = injectGuidance(request, GUIDANCE, "openai");
    const messages = out["messages"] as Array<Record<string, unknown>>;
    expect(messages.length).toBe(2);
    expect(messages[0]?.["role"]).toBe("system");
    expect(messages[0]?.["content"]).toBe(GUIDANCE.trimStart());
  });

  test("appends a new text block when system content is an array", () => {
    const request = {
      messages: [
        { role: "system", content: [{ type: "text", text: "Part one." }] },
        { role: "user", content: "hi" },
      ],
    };
    const out = injectGuidance(request, GUIDANCE, "openai");
    const messages = out["messages"] as Array<Record<string, unknown>>;
    const sys = messages[0]?.["content"] as Array<Record<string, unknown>>;
    expect(sys.length).toBe(2);
    expect(sys[1]?.["type"]).toBe("text");
    expect(sys[1]?.["text"]).toBe(GUIDANCE);
  });

  test("does not mutate the input request", () => {
    const request = { messages: [{ role: "system", content: "S" }] };
    injectGuidance(request, GUIDANCE, "openai");
    expect(request.messages[0]?.content).toBe("S");
  });
});

describe("injectGuidance (Anthropic)", () => {
  test("appends to existing string system", () => {
    const out = injectGuidance(
      { messages: [], system: "You are helpful." },
      GUIDANCE,
      "anthropic",
    );
    expect(out["system"]).toBe("You are helpful." + GUIDANCE);
  });

  test("appends block to array system", () => {
    const out = injectGuidance(
      { messages: [], system: [{ type: "text", text: "S" }] },
      GUIDANCE,
      "anthropic",
    );
    const sys = out["system"] as Array<Record<string, unknown>>;
    expect(sys.length).toBe(2);
    expect(sys[1]?.["text"]).toBe(GUIDANCE);
  });

  test("creates system field when missing", () => {
    const out = injectGuidance({ messages: [] }, GUIDANCE, "anthropic");
    expect(out["system"]).toBe(GUIDANCE.trimStart());
  });
});
