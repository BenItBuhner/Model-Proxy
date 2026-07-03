import { describe, it, expect } from "bun:test";
import { classifyConversationDelta } from "../src/routing/fusion/reasoning-cache.ts";
import { ResponseFuser } from "../src/routing/fusion/response-fuser.ts";
import {
  AsyncEventQueue,
  compactFallbackSummary,
  parseOpenAIDelta,
  splitSseEvents,
} from "../src/routing/fusion/reasoning-summarizer.ts";

// ── Conversation delta classification ────────────────────────────────

describe("classifyConversationDelta", () => {
  const base = [{ role: "user", content: "Refactor the auth middleware to support API keys." }];

  it("treats an empty delta as trivial", () => {
    const result = classifyConversationDelta(base, []);
    expect(result.significant).toBe(false);
  });

  it("treats a substantial new user message as significant", () => {
    const delta = [{ role: "user", content: "Actually, also add rate limiting per principal and persist counters in sqlite." }];
    const result = classifyConversationDelta([...base, ...delta], delta);
    expect(result.significant).toBe(true);
    expect(result.reason).toContain("user instruction");
  });

  it("treats short user acknowledgments as trivial", () => {
    const delta = [{ role: "user", content: "ok, continue" }];
    const result = classifyConversationDelta([...base, ...delta], delta);
    expect(result.significant).toBe(false);
  });

  it("treats todo-list tool activity as trivial", () => {
    const all = [
      ...base,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "todowrite", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "Updated todo list: 3 items pending." },
    ];
    const delta = all.slice(1);
    const result = classifyConversationDelta(all, delta);
    expect(result.significant).toBe(false);
  });

  it("treats tool results with code fences as significant", () => {
    const all = [
      ...base,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_2", content: "```ts\nexport function authenticate() { return true; }\n```" },
    ];
    const delta = all.slice(1);
    const result = classifyConversationDelta(all, delta);
    expect(result.significant).toBe(true);
  });

  it("treats large tool results as significant", () => {
    const all = [
      ...base,
      { role: "tool", tool_call_id: "call_3", content: "x".repeat(2000) },
    ];
    const delta = all.slice(1);
    const result = classifyConversationDelta(all, delta);
    expect(result.significant).toBe(true);
  });

  it("treats small confirmation tool results as trivial", () => {
    const all = [
      ...base,
      { role: "tool", tool_call_id: "call_4", content: "Done." },
    ];
    const delta = all.slice(1);
    const result = classifyConversationDelta(all, delta);
    expect(result.significant).toBe(false);
  });

  it("treats error-bearing tool results as significant", () => {
    const all = [
      ...base,
      { role: "tool", tool_call_id: "call_5", content: "TypeError: cannot read property 'foo' of undefined" },
    ];
    const delta = all.slice(1);
    const result = classifyConversationDelta(all, delta);
    expect(result.significant).toBe(true);
  });

  it("treats new images as significant", () => {
    const all = [
      ...base,
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,xyz" } }] },
    ];
    const delta = all.slice(1);
    const result = classifyConversationDelta(all, delta);
    expect(result.significant).toBe(true);
  });

  it("treats assistant-only deltas as trivial", () => {
    const all = [
      ...base,
      { role: "assistant", content: "I'll start by reviewing the middleware." },
    ];
    const delta = all.slice(1);
    const result = classifyConversationDelta(all, delta);
    expect(result.significant).toBe(false);
  });
});

// ── ResponseFuser.extractContent tool_calls guard ─────────────────────

describe("ResponseFuser extractContent", () => {
  const fuser = new ResponseFuser() as unknown as {
    extractContent: (response: Record<string, unknown>, toolCalls?: unknown[]) => string | null;
  };

  it("returns null content when tool_calls are present with null content", () => {
    const toolCalls = [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }];
    const response = {
      choices: [{ message: { role: "assistant", content: null, tool_calls: toolCalls } }],
    };
    expect(fuser.extractContent(response, toolCalls)).toBeNull();
  });

  it("never stringifies the raw response as content", () => {
    const response = { choices: [{ message: { role: "assistant", content: null } }] };
    const extracted = fuser.extractContent(response, undefined);
    expect(extracted).not.toContain("choices");
  });

  it("returns plain string content when present", () => {
    const response = { choices: [{ message: { role: "assistant", content: "hello" } }] };
    expect(fuser.extractContent(response, undefined)).toBe("hello");
  });
});

// ── SSE parsing helpers ───────────────────────────────────────────────

describe("SSE helpers", () => {
  it("splits multi-event payloads", () => {
    const raw = `data: {"a":1}\n\ndata: {"b":2}\n\n`;
    const events = splitSseEvents(raw);
    expect(events.length).toBe(2);
  });

  it("parses content and reasoning deltas", () => {
    const event = `data: ${JSON.stringify({
      choices: [{ delta: { content: "hi", reasoning_content: "thinking" }, finish_reason: null }],
    })}\n\n`;
    const parsed = parseOpenAIDelta(event);
    expect(parsed).not.toBeNull();
    expect(parsed!.content).toBe("hi");
    expect(parsed!.reasoning).toBe("thinking");
  });

  it("detects tool_call deltas", () => {
    const event = `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "f", arguments: "" } }] } }],
    })}\n\n`;
    const parsed = parseOpenAIDelta(event);
    expect(parsed!.hasToolCalls).toBe(true);
  });

  it("returns null for [DONE]", () => {
    expect(parseOpenAIDelta("data: [DONE]\n\n")).toBeNull();
  });
});

// ── AsyncEventQueue ───────────────────────────────────────────────────

describe("AsyncEventQueue", () => {
  it("delivers pushed items in order and terminates on close", async () => {
    const queue = new AsyncEventQueue<number>();
    queue.push(1);
    queue.push(2);
    setTimeout(() => {
      queue.push(3);
      queue.close();
    }, 10);

    const received: number[] = [];
    for await (const item of queue) {
      received.push(item);
    }
    expect(received).toEqual([1, 2, 3]);
  });
});

// ── compactFallbackSummary ────────────────────────────────────────────

describe("compactFallbackSummary", () => {
  it("strips think tags and compacts whitespace", () => {
    const text = "<think>secret chain of thought</think>  Found   the bug in auth.ts ";
    expect(compactFallbackSummary(text)).toBe("Found the bug in auth.ts.");
  });

  it("caps very long text at a word boundary without ellipsis", () => {
    const out = compactFallbackSummary("word ".repeat(500));
    expect(out.length).toBeLessThanOrEqual(300);
    expect(out.endsWith("...")).toBe(false);
    expect(out.endsWith(".")).toBe(true);
  });

  it("keeps at most two complete sentences", () => {
    const text = "First finding here. Second detail follows. Third one should be dropped. Fourth too.";
    const out = compactFallbackSummary(text);
    expect(out).toBe("First finding here. Second detail follows.");
  });

  it("never emits raw code fences or tool-call JSON", () => {
    const text = 'Analyzing the router. ```json\n{"tool_calls": [{"name": "write_file"}]}\n``` {"name": "bash", "arguments": {"cmd": "rm -rf /"}} The fallback path looks correct.';
    const out = compactFallbackSummary(text);
    expect(out).not.toContain("tool_calls");
    expect(out).not.toContain("write_file");
    expect(out).not.toContain("rm -rf");
    expect(out).toContain("Analyzing the router.");
  });
});
