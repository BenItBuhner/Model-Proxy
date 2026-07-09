import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getAnalyticsSummary } from "../src/storage/analytics-store.ts";
import { listRequestIndexRows, readCompletionEnvelope } from "../src/storage/completion-store.ts";
import { listRequestMetricRows } from "../src/storage/metrics-store.ts";
import { writeAnalyticsPricingSettings } from "../src/storage/pricing-store.ts";
import { getStorageRoot, setStorageRootForTests } from "../src/storage/storage-paths.ts";
import {
  recordRequestFinish,
  recordRequestProgress,
  recordRequestStart,
  resetRequestLogForTests,
} from "../src/server/request-log.ts";

const tmpRoot = join(tmpdir(), `mp-storage-${process.pid}-${Date.now()}`);

beforeEach(() => {
  delete process.env.PERSIST_COMPLETIONS;
  setStorageRootForTests(tmpRoot);
  resetRequestLogForTests();
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  resetRequestLogForTests();
  setStorageRootForTests(undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("persistent completion storage and analytics", () => {
  test("does not persist completion envelopes by default", () => {
    recordRequestStart({
      requestId: "storage-default-off",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      resolvedModel: "demo",
      wireProtocol: "openai",
      isStreaming: false,
      enforceMode: false,
      requestBody: {
        model: "demo",
        messages: [{ role: "user", content: "do not write me" }],
      },
    });
    recordRequestProgress({
      requestId: "storage-default-off",
      resolvedProvider: "openai",
      resolvedModel: "gpt-demo",
      apiKeyEnvVar: "OPENAI_API_KEY_1",
    });
    recordRequestFinish({
      requestId: "storage-default-off",
      responseStatus: 200,
      responseTimeMs: 50,
      responseBody: {
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      },
    });

    expect(listRequestIndexRows({ limit: undefined, offset: 0 }).records).toHaveLength(0);
    const metrics = listRequestMetricRows({ limit: undefined, offset: 0 }).records;
    expect(metrics).toHaveLength(1);
    expect(metrics[0]?.totalTokens).toBe(4);
    const summary = getAnalyticsSummary({}, 0);
    expect(summary.totalTokens).toBe(4);
    expect(summary.savedCostUsd).toBeGreaterThan(0);
    expect(readCompletionEnvelope("storage-default-off")).toBeUndefined();
  });

  test("writes sanitized completion envelopes and request indexes", () => {
    writeAnalyticsPricingSettings({
      default_pricing: {
        user_cost: { input_per_1m: 0, output_per_1m: 0 },
        typical_cost: { input_per_1m: 1, output_per_1m: 2 },
      },
    });

    recordRequestStart({
      requestId: "storage-1",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      resolvedModel: "demo",
      wireProtocol: "openai",
      isStreaming: false,
      enforceMode: false,
      promptTokens: 10,
      promptTokensEstimated: true,
      requestBody: {
        model: "demo",
        messages: [{ role: "user", content: "hello" }],
        api_key: "must-not-persist",
        headers: { Authorization: "Bearer nope" },
      },
      persistCompletions: true,
    });
    recordRequestProgress({
      requestId: "storage-1",
      resolvedProvider: "openai",
      resolvedModel: "gpt-demo",
      apiKeyEnvVar: "OPENAI_API_KEY_1",
      keyHint: "...1234",
    });
    recordRequestFinish({
      requestId: "storage-1",
      responseStatus: 200,
      responseTimeMs: 125,
      responseBody: {
        choices: [{ message: { content: "world" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    expect(existsSync(getStorageRoot())).toBe(true);
    const rows = listRequestIndexRows({ limit: 10, offset: 0 }).records;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.totalTokens).toBe(15);
    expect(rows[0]?.typicalCostUsd).toBeGreaterThan(0);

    const envelope = readCompletionEnvelope("storage-1");
    expect(envelope?.requestId).toBe("storage-1");
    const raw = readFileSync(join(getStorageRoot(), rows[0]!.path), "utf8");
    expect(raw).not.toContain("must-not-persist");
    expect(raw).not.toContain("Bearer nope");
    expect(raw).toContain("[redacted]");
  });

  test("rebuilds analytics summary from persisted index rows", () => {
    recordRequestStart({
      requestId: "analytics-1",
      endpoint: "/v1/messages",
      method: "POST",
      requestedModel: "claude-demo",
      resolvedModel: "claude-demo",
      wireProtocol: "anthropic",
      isStreaming: false,
      enforceMode: false,
      requestBody: { model: "claude-demo", messages: [{ role: "user", content: "same" }] },
      persistCompletions: true,
    });
    recordRequestProgress({
      requestId: "analytics-1",
      resolvedProvider: "anthropic",
      resolvedModel: "claude-demo",
      apiKeyEnvVar: "ANTHROPIC_API_KEY",
      keyHint: "...abcd",
    });
    recordRequestFinish({
      requestId: "analytics-1",
      responseStatus: 200,
      responseTimeMs: 100,
      responseBody: {
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          cache_read_input_tokens: 6,
        },
      },
    });

    const summary = getAnalyticsSummary({}, 0);
    expect(summary.completedRequests).toBe(1);
    expect(summary.totalTokens).toBe(20);
    expect(summary.cacheReadTokens).toBe(6);
    expect(summary.byProviderKey[0]?.provider).toBe("anthropic");
    expect(summary.byProviderKey[0]?.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
  });

  test("analytics summary includes more than the first 100 persisted rows", () => {
    for (let i = 0; i < 125; i += 1) {
      recordRequestStart({
        requestId: `bulk-${i}`,
        endpoint: "/v1/chat/completions",
        method: "POST",
        requestedModel: "bulk-model",
        resolvedModel: "bulk-model",
        wireProtocol: "openai",
        isStreaming: false,
        enforceMode: false,
        requestBody: { model: "bulk-model", messages: [{ role: "user", content: `hello ${i}` }] },
        persistCompletions: true,
      });
      recordRequestProgress({
        requestId: `bulk-${i}`,
        resolvedProvider: "openai",
        resolvedModel: "bulk-backend",
        apiKeyEnvVar: "OPENAI_API_KEY",
      });
      recordRequestFinish({
        requestId: `bulk-${i}`,
        responseStatus: 200,
        responseTimeMs: 100 + i,
        responseBody: {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      });
    }

    const rows = listRequestIndexRows({ limit: undefined, offset: 0 }).records;
    const summary = getAnalyticsSummary({}, 0);
    expect(rows).toHaveLength(125);
    expect(summary.completedRequests).toBe(125);
    expect(summary.totalTokens).toBe(125 * 15);
  });

  test("cache matching checks all eligible fingerprints in the window", () => {
    writeAnalyticsPricingSettings({
      default_pricing: {
        user_cost: { input_per_1m: 0, output_per_1m: 0 },
        typical_cost: { input_per_1m: 10, output_per_1m: 0, cache_read_per_1m: 1 },
      },
    });

    for (const [id, content] of [
      ["cache-a1", "conversation a"],
      ["cache-b1", "conversation b"],
      ["cache-a2", "conversation a"],
    ] as const) {
      recordRequestStart({
        requestId: id,
        endpoint: "/v1/chat/completions",
        method: "POST",
        requestedModel: "cache-model",
        resolvedModel: "cache-model",
        wireProtocol: "openai",
        isStreaming: false,
        enforceMode: false,
        requestBody: { model: "cache-model", messages: [{ role: "user", content }] },
        persistCompletions: true,
      });
      recordRequestProgress({
        requestId: id,
        resolvedProvider: "openai",
        resolvedModel: "cache-backend",
        apiKeyEnvVar: "OPENAI_API_KEY",
      });
      recordRequestFinish({
        requestId: id,
        responseStatus: 200,
        responseTimeMs: 100,
        responseBody: {
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 0, total_tokens: 100 },
        },
      });
    }

    const rows = listRequestIndexRows({ limit: undefined, offset: 0 }).records;
    const hit = rows.find((row) => row.requestId === "cache-a2");
    const miss = rows.find((row) => row.requestId === "cache-b1");
    expect(hit?.isCacheHit).toBe(true);
    expect(hit?.matchedTokens).toBe(100);
    expect(hit?.cacheReadTokens).toBe(100);
    expect(hit?.typicalCostUsd).toBe(0.0001);
    expect(miss?.isCacheHit).toBe(false);
  });
});
