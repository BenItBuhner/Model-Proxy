import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { ReasoningCache } from "../src/routing/fusion/reasoning-cache.ts";
import type { FusionRequestContext, SubTask, ComplexityScore, SubagentResult } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "../shared/schemas/fusion.ts";
import * as fs from "node:fs";
import * as path from "node:path";

const TEST_CACHE_DIR = path.join("/tmp", `fusion-cache-test-${Date.now()}`);
const testFusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.15, effort_2_threshold: 0.45 },
  task_divider: { model_routing: "glm-5.2" },
  effort_levels: {
    1: { model_routing: "turbo" },
  },
  fusion: { model_routing: "complete", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: true, scope: "permanent" },
};

function makeCtx(messages: unknown[]): FusionRequestContext {
  return {
    logicalModel: "fusion-beta",
    fusionConfig: testFusionConfig,
    requestData: { messages },
    clientProtocol: "openai",
    messages,
  };
}

describe("ReasoningCache", () => {
  let cache: ReasoningCache;

  beforeEach(() => {
    cache = new ReasoningCache(TEST_CACHE_DIR);
  });

  afterEach(() => {
    // Cleanup test directory
    try {
      const files = fs.readdirSync(TEST_CACHE_DIR);
      for (const f of files) fs.unlinkSync(path.join(TEST_CACHE_DIR, f));
      fs.rmdirSync(TEST_CACHE_DIR);
    } catch { /* ok */ }
  });

  it("stores and retrieves cache entries", () => {
    const ctx = makeCtx([
      { role: "user", content: "Test query" },
    ]);
    const subTasks: SubTask[] = [
      { id: "t1", description: "Sub task 1", focus_area: "test", suggested_model_routing: "complete" },
    ];
    const score: ComplexityScore = { score: 0.1, effort: 1, reason: "test", tokenCount: 10 };
    const results: SubagentResult[] = [
      {
        subTask: subTasks[0],
        success: true,
        usedModelRouting: "complete",
        content: "Result content",
        durationMs: 100,
      },
    ];

    const key = cache.computeKey(ctx, subTasks);
    cache.set(key, results, subTasks, score, "Fused output");

    const retrieved = cache.get(key);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.subagentResults.length).toBe(1);
    expect(retrieved!.subagentResults[0].content).toBe("Result content");
    expect(retrieved!.fusedContent).toBe("Fused output");
    expect(retrieved!.complexityScore.score).toBe(0.1);
  });

  it("returns null for cache misses", () => {
    const result = cache.get("nonexistent-key-12345");
    expect(result).toBeNull();
  });

  it("computes consistent keys for identical inputs", () => {
    const ctx1 = makeCtx([{ role: "user", content: "Same query" }]);
    const ctx2 = makeCtx([{ role: "user", content: "Same query" }]);
    const tasks1: SubTask[] = [{ id: "a", description: "Task A", focus_area: "x", suggested_model_routing: "m" }];
    const tasks2: SubTask[] = [{ id: "a", description: "Task A", focus_area: "x", suggested_model_routing: "m" }];

    const key1 = cache.computeKey(ctx1, tasks1);
    const key2 = cache.computeKey(ctx2, tasks2);
    expect(key1).toBe(key2);
  });

  it("computes different keys for different inputs", () => {
    const ctx1 = makeCtx([{ role: "user", content: "Query A" }]);
    const ctx2 = makeCtx([{ role: "user", content: "Query B" }]);
    const tasks: SubTask[] = [{ id: "a", description: "Task", focus_area: "x", suggested_model_routing: "m" }];

    const key1 = cache.computeKey(ctx1, tasks);
    const key2 = cache.computeKey(ctx2, tasks);
    expect(key1).not.toBe(key2);
  });

  it("reports cache size correctly", () => {
    expect(cache.size).toBe(0);

    const ctx = makeCtx([{ role: "user", content: "Test" }]);
    const tasks: SubTask[] = [{ id: "t1", description: "Test", focus_area: "x", suggested_model_routing: "m" }];
    const score: ComplexityScore = { score: 0.1, effort: 1, reason: "test", tokenCount: 0 };

    const key = cache.computeKey(ctx, tasks);
    cache.set(key, [], tasks, score);

    expect(cache.size).toBe(1);
  });

  it("has() checks existence", () => {
    const ctx = makeCtx([{ role: "user", content: "Existence test" }]);
    const tasks: SubTask[] = [{ id: "t1", description: "Test", focus_area: "x", suggested_model_routing: "m" }];
    const score: ComplexityScore = { score: 0.1, effort: 1, reason: "test", tokenCount: 0 };

    const key = cache.computeKey(ctx, tasks);
    expect(cache.has(key)).toBe(false);

    cache.set(key, [], tasks, score);
    expect(cache.has(key)).toBe(true);
  });
});
