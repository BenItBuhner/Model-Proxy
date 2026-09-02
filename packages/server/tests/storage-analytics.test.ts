import { rmWithRetry } from "./support.ts";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getAnalyticsSummary, getAnalyticsTimeseries } from "../src/storage/analytics-store.ts";
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
  rmWithRetry(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  resetRequestLogForTests();
  setStorageRootForTests(undefined);
  rmWithRetry(tmpRoot, { recursive: true, force: true });
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
    expect(summary.promptTokens).toBe(18);
    expect(summary.totalTokens).toBe(26);
    expect(summary.cacheReadTokens).toBe(6);
    expect(summary.byProviderKey[0]?.provider).toBe("anthropic");
    expect(summary.byProviderKey[0]?.apiKeyEnvVar).toBe("ANTHROPIC_API_KEY");
    expect(summary.byProviderKey[0]?.promptTokens).toBe(18);
    expect(summary.byProviderKey[0]?.completionTokens).toBe(8);
    expect(summary.byProviderKey[0]?.totalTokens).toBe(26);
    expect(summary.byProviderKey[0]?.cacheReadTokens).toBe(6);
    expect(summary.byProviderKey[0]?.cacheCreationTokens).toBe(0);
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

  test("provider-reported zero cached tokens overrides the fingerprint window", () => {
    for (const [id, content] of [
      ["cache-zero-1", "conversation zero"],
      ["cache-zero-2", "conversation zero"],
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
          usage: {
            prompt_tokens: 100,
            completion_tokens: 0,
            total_tokens: 100,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        },
      });
    }

    const rows = listRequestIndexRows({ limit: undefined, offset: 0 }).records;
    const second = rows.find((row) => row.requestId === "cache-zero-2");
    expect(second?.isCacheHit).toBe(false);
    expect(second?.matchedTokens).toBe(0);
    expect(second?.cacheReadTokens).toBe(0);
  });

  test("streamed usage with provider cached tokens records a cache hit", () => {
    recordRequestStart({
      requestId: "stream-cache-1",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      resolvedModel: "demo",
      wireProtocol: "openai",
      isStreaming: true,
      enforceMode: false,
      promptTokens: 999,
      promptTokensEstimated: true,
      requestBody: { model: "demo", messages: [{ role: "user", content: "grown conversation" }] },
      persistCompletions: true,
    });
    recordRequestProgress({
      requestId: "stream-cache-1",
      resolvedProvider: "openai",
      resolvedModel: "gpt-demo",
      apiKeyEnvVar: "OPENAI_API_KEY",
    });
    // Mirrors what StreamUsageTracker.finish() emits after parsing an SSE
    // usage chunk containing prompt_tokens_details.cached_tokens.
    recordRequestFinish({
      requestId: "stream-cache-1",
      responseStatus: 200,
      responseTimeMs: 80,
      completionTokens: 50,
      completionTokensEstimated: false,
      usage: {
        promptTokens: 1200,
        completionTokens: 50,
        totalTokens: 1250,
        cacheReadTokens: 1024,
        cachedTokens: 1024,
      },
    });

    const rows = listRequestIndexRows({ limit: undefined, offset: 0 }).records;
    const row = rows.find((candidate) => candidate.requestId === "stream-cache-1");
    expect(row?.isCacheHit).toBe(true);
    expect(row?.matchedTokens).toBe(1024);
    expect(row?.cacheReadTokens).toBe(1024);
    expect(row?.promptTokens).toBe(1200);
  });

  test("timeseries aggregates tokens and dollar costs by hour and day", () => {
    recordRequestStart({
      requestId: "ts-1",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      resolvedModel: "demo",
      wireProtocol: "openai",
      isStreaming: false,
      enforceMode: false,
      requestBody: { model: "demo", messages: [{ role: "user", content: "one" }] },
    });
    recordRequestProgress({
      requestId: "ts-1",
      resolvedProvider: "openai",
      resolvedModel: "gpt-demo",
      apiKeyEnvVar: "OPENAI_API_KEY",
    });
    recordRequestFinish({
      requestId: "ts-1",
      responseStatus: 200,
      responseTimeMs: 40,
      responseBody: {
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    });

    recordRequestStart({
      requestId: "ts-2",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      resolvedModel: "demo",
      wireProtocol: "openai",
      isStreaming: false,
      enforceMode: false,
      requestBody: { model: "demo", messages: [{ role: "user", content: "two" }] },
    });
    recordRequestProgress({
      requestId: "ts-2",
      resolvedProvider: "openai",
      resolvedModel: "gpt-demo",
      apiKeyEnvVar: "OPENAI_API_KEY",
    });
    recordRequestFinish({
      requestId: "ts-2",
      responseStatus: 200,
      responseTimeMs: 55,
      responseBody: {
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      },
    });

    const hourly = getAnalyticsTimeseries({}, "hour");
    expect(hourly.length).toBeGreaterThanOrEqual(1);
    const hourTotal = hourly.reduce((sum, point) => sum + point.totalTokens, 0);
    expect(hourTotal).toBe(45);
    expect(hourly[0]?.promptTokens).toBeGreaterThan(0);
    expect(hourly[0]?.completionTokens).toBeGreaterThan(0);
    expect(hourly[0]?.userCostUsd).toBeGreaterThanOrEqual(0);

    const daily = getAnalyticsTimeseries({}, "day");
    expect(daily).toHaveLength(1);
    expect(daily[0]?.requests).toBe(2);
    expect(daily[0]?.totalTokens).toBe(45);
  });

  test("metric reads pick up newly written rows without a process restart", () => {
    recordRequestStart({
      requestId: "cache-1",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      isStreaming: false,
      enforceMode: false,
    });
    recordRequestFinish({
      requestId: "cache-1",
      responseStatus: 200,
      responseTimeMs: 10,
      responseBody: { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    });
    expect(listRequestMetricRows({ limit: undefined, offset: 0 }).records).toHaveLength(1);

    recordRequestStart({
      requestId: "cache-2",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo",
      isStreaming: false,
      enforceMode: false,
    });
    recordRequestFinish({
      requestId: "cache-2",
      responseStatus: 200,
      responseTimeMs: 11,
      responseBody: { usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } },
    });
    expect(listRequestMetricRows({ limit: undefined, offset: 0 }).records).toHaveLength(2);
    const first = getAnalyticsSummary({}, 0);
    const second = getAnalyticsSummary({}, 0);
    expect(second.totalRequests).toBe(first.totalRequests);
    expect(second.totalTokens).toBe(first.totalTokens);
  });
});
