import { describe, expect, test } from "bun:test";

import { StreamUsageTracker } from "../src/observability/stream-usage.ts";

function makeTracker(protocol: "openai" | "anthropic"): StreamUsageTracker {
  return new StreamUsageTracker(protocol, { captureText: false, maxCapturedChars: 0 });
}

describe("StreamUsageTracker (openai)", () => {
  test("captures cached tokens from prompt_tokens_details", () => {
    const tracker = makeTracker("openai");
    tracker.ingest('data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}\n\n');
    tracker.ingest(
      'data: {"choices":[],"usage":{"prompt_tokens":1200,"completion_tokens":50,"total_tokens":1250,"prompt_tokens_details":{"cached_tokens":1024}}}\n\n',
    );
    tracker.ingest("data: [DONE]\n\n");
    const result = tracker.finish();
    expect(result.usage?.promptTokens).toBe(1200);
    expect(result.usage?.completionTokens).toBe(50);
    expect(result.usage?.cacheReadTokens).toBe(1024);
    expect(result.usage?.cachedTokens).toBe(1024);
    expect(result.completionTokensEstimated).toBe(false);
  });

  test("falls back to top-level anthropic-style cache fields from compat upstreams", () => {
    const tracker = makeTracker("openai");
    tracker.ingest(
      'data: {"choices":[],"usage":{"prompt_tokens":500,"completion_tokens":10,"cache_read_input_tokens":400,"cache_creation_input_tokens":50}}\n\n',
    );
    const result = tracker.finish();
    expect(result.usage?.cacheReadTokens).toBe(400);
    expect(result.usage?.cacheCreationTokens).toBe(50);
  });

  test("leaves cache fields undefined when upstream reports none", () => {
    const tracker = makeTracker("openai");
    tracker.ingest(
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n',
    );
    const result = tracker.finish();
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.cacheReadTokens).toBeUndefined();
  });
});

describe("StreamUsageTracker (anthropic)", () => {
  test("captures cache tokens from nested message_start usage", () => {
    const tracker = makeTracker("anthropic");
    tracker.ingest(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":100,"output_tokens":1}}}\n\n',
    );
    tracker.ingest(
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    );
    tracker.ingest(
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n',
    );
    const result = tracker.finish();
    expect(result.usage?.promptTokens).toBe(10);
    expect(result.usage?.cacheReadTokens).toBe(900);
    expect(result.usage?.cacheCreationTokens).toBe(100);
    expect(result.completionTokens).toBe(42);
    expect(result.completionTokensEstimated).toBe(false);
  });

  test("message_delta usage does not clobber cache fields from message_start", () => {
    const tracker = makeTracker("anthropic");
    tracker.ingest(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":300}}}\n\n',
    );
    tracker.ingest(
      'event: message_delta\ndata: {"type":"message_delta","delta":{},"usage":{"output_tokens":7}}\n\n',
    );
    const result = tracker.finish();
    expect(result.usage?.cacheReadTokens).toBe(300);
    expect(result.usage?.promptTokens).toBe(5);
    expect(result.usage?.completionTokens).toBe(7);
  });
});
