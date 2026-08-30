import { describe, expect, test } from "bun:test";
import {
  pureContentDelta,
  StreamPacer,
  withDeltaContent,
} from "../src/providers/stream-pacer.ts";

function contentChunk(text: string): Record<string, unknown> {
  return {
    id: "chunk-1",
    object: "chat.completion.chunk",
    model: "m",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

async function collectFeed(pacer: StreamPacer, text: string): Promise<string[]> {
  const pieces: string[] = [];
  for await (const piece of pacer.feed(text)) pieces.push(piece);
  return pieces;
}

describe("StreamPacer", () => {
  test("emits the first piece immediately at a word boundary", async () => {
    const pacer = new StreamPacer();
    const pieces = await collectFeed(pacer, "Hello there general kenobi");
    expect(pieces).toEqual(["Hello "]);
  });

  test("holds fragments below the target until enough accumulates", async () => {
    const pacer = new StreamPacer();
    const all: string[] = [];
    all.push(...(await collectFeed(pacer, "hi")));
    expect(all).toEqual([]);
    all.push(...(await collectFeed(pacer, " the")));
    expect(all).toEqual(["hi "]);
    const pieces = await collectFeed(pacer, "re and then some more words here");
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      expect(piece.length).toBeGreaterThanOrEqual(24);
    }
    all.push(...pieces);
    expect(all.join("") + pacer.drain()).toBe("hi there and then some more words here");
  });

  test("re-chunks a large burst into paced word-boundary pieces", async () => {
    const pacer = new StreamPacer();
    const sentence = "The quick brown fox jumps over the lazy dog again and again. ";
    const pieces = await collectFeed(pacer, sentence.repeat(3));
    expect(pieces.length).toBeGreaterThan(3);
    for (const piece of pieces.slice(1)) {
      expect(piece.length).toBeGreaterThanOrEqual(24);
      expect(piece.endsWith(" ")).toBe(true);
    }
    expect(pieces.join("") + pacer.drain()).toBe(sentence.repeat(3));
  });

  test("force-cuts whitespace-free runs at the max piece size", async () => {
    const pacer = new StreamPacer();
    const blob = "x".repeat(400);
    const pieces = await collectFeed(pacer, blob);
    expect(pieces.every((p) => p.length <= 160)).toBe(true);
    expect(pieces.join("") + pacer.drain()).toBe(blob);
  });

  test("drain returns the remainder and empties the buffer", async () => {
    const pacer = new StreamPacer();
    await collectFeed(pacer, "partialtail");
    expect(pacer.drain()).toBe("partialtail");
    expect(pacer.drain()).toBe("");
  });

  test("nothing is lost across feed and drain", async () => {
    const pacer = new StreamPacer();
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const pieces = await collectFeed(pacer, text);
    expect(pieces.join("") + pacer.drain()).toBe(text);
  });
});

describe("pureContentDelta", () => {
  test("returns text for plain content deltas", () => {
    expect(pureContentDelta(contentChunk("hi there"))).toBe("hi there");
  });

  test("returns undefined for empty or missing content", () => {
    expect(pureContentDelta(contentChunk(""))).toBeUndefined();
    const roleOnly = {
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    };
    expect(pureContentDelta(roleOnly)).toBeUndefined();
  });

  test("returns undefined for tool calls, reasoning, and finish frames", () => {
    const toolCall = {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ id: "call_1", function: { name: "f", arguments: "" } }] },
          finish_reason: null,
        },
      ],
    };
    expect(pureContentDelta(toolCall)).toBeUndefined();
    const reasoning = {
      choices: [{ index: 0, delta: { reasoning_content: "thinking" }, finish_reason: null }],
    };
    expect(pureContentDelta(reasoning)).toBeUndefined();
    const finish = {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    expect(pureContentDelta(finish)).toBeUndefined();
  });

  test("returns undefined for malformed or multi-choice chunks", () => {
    expect(pureContentDelta({})).toBeUndefined();
    expect(pureContentDelta({ choices: "nope" })).toBeUndefined();
    const multi = {
      choices: [
        { index: 0, delta: { content: "a" }, finish_reason: null },
        { index: 1, delta: { content: "b" }, finish_reason: null },
      ],
    };
    expect(pureContentDelta(multi)).toBeUndefined();
  });
});

describe("withDeltaContent", () => {
  test("replaces content and preserves the rest of the chunk", () => {
    const chunk = contentChunk("original");
    const rewritten = withDeltaContent(chunk, "piece");
    expect((rewritten["choices"] as Array<Record<string, unknown>>)[0]!["delta"]).toEqual({
      content: "piece",
    });
    expect(rewritten["id"]).toBe("chunk-1");
    expect(rewritten["model"]).toBe("m");
  });

  test("keeps other delta fields like role", () => {
    const chunk = {
      choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }],
    };
    const rewritten = withDeltaContent(chunk, "y");
    expect((rewritten["choices"] as Array<Record<string, unknown>>)[0]!["delta"]).toEqual({
      role: "assistant",
      content: "y",
    });
  });
});
