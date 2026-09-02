import { describe, it, expect } from "bun:test";
import {
  isMeaningfulStreamChunk,
  requireMeaningfulStream,
} from "../src/routing/stream-inspection.ts";
import { ProviderAPIError } from "../src/providers/errors.ts";

function sseGen(chunks: string[]): AsyncGenerator<string, void, unknown> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

const lifecycleOnly = [
  'data: {"type":"response.created","response":{"id":"r","status":"in_progress","output":[]}}\n\n',
  'data: {"type":"response.in_progress","response":{"id":"r","status":"in_progress","output":[]}}\n\n',
  'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"reasoning","id":"x","status":"in_progress","summary":[],"content":[]}}\n\n',
  'data: {"type":"response.completed","response":{"id":"r","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
];

describe("responses empty-stream guard", () => {
  it("does not count lifecycle-only events as meaningful content", () => {
    for (const chunk of lifecycleOnly) {
      expect(
        isMeaningfulStreamChunk(chunk, "responses", 1),
      ).toBe(false);
    }
  });

  it("counts content deltas as meaningful", () => {
    expect(
      isMeaningfulStreamChunk(
        'data: {"type":"response.output_text.delta","delta":"Hi"}\n\n',
        "responses",
        1,
      ),
    ).toBe(true);
    expect(
      isMeaningfulStreamChunk(
        'data: {"type":"response.reasoning_text.delta","delta":"thinking"}\n\n',
        "responses",
        1,
      ),
    ).toBe(true);
    expect(
      isMeaningfulStreamChunk(
        'data: {"type":"response.function_call_arguments.delta","delta":"{}"}\n\n',
        "responses",
        1,
      ),
    ).toBe(true);
  });

  it("throws fallback-worthy 502 for lifecycle-only responses streams", async () => {
    const route = {
      provider: "nahcrof",
      model: "kimi-k3",
      wireProtocol: "responses",
    } as Parameters<typeof requireMeaningfulStream>[1];
    await expect(async () => {
      for await (const _ of requireMeaningfulStream(
        sseGen(lifecycleOnly),
        route,
        {},
        "responses",
      )) {
        // consume
      }
    }).toThrow(ProviderAPIError);
  });

  it("still passes through when the client already saw bytes", async () => {
    const route = {
      provider: "nahcrof",
      model: "kimi-k3",
      wireProtocol: "responses",
    } as Parameters<typeof requireMeaningfulStream>[1];
    const out: string[] = [];
    for await (const chunk of requireMeaningfulStream(
      sseGen(lifecycleOnly),
      route,
      {},
      "responses",
      { allowEmptyPassthrough: true },
    )) {
      out.push(chunk);
    }
    expect(out.length).toBe(lifecycleOnly.length);
  });

  it("openai empty stream without passthrough still throws", async () => {
    const route = {
      provider: "p",
      model: "m",
      wireProtocol: "openai",
    } as Parameters<typeof requireMeaningfulStream>[1];
    await expect(async () => {
      for await (const _ of requireMeaningfulStream(
        sseGen(['data: {"choices":[{"delta":{}}]}\n\n']),
        route,
        {},
        "openai",
      )) {
        // consume
      }
    }).toThrow(ProviderAPIError);
  });
});
