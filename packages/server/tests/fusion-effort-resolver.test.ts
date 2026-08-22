import { describe, expect, it } from "bun:test";

import { resolveFusionEffort } from "../src/routing/fusion/effort-resolver.ts";
import type { ComplexityScore, FusionRequestContext } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "@model-proxy/contracts/schemas/fusion.ts";

const fusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.2, effort_2_threshold: 0.55 },
  task_divider: { model_routing: "divider", timeout_seconds: 30, max_subtasks: 4 },
  effort_levels: {
    1: { model_routing: "fast" },
    2: { subagent_count: { min: 2, max: 4 }, model_routings: ["worker"], tools: ["context_search"] },
    3: { subagent_count: { min: 4, max: 8 }, model_routings: ["worker"], tools: ["context_search", "web_search"] },
  },
  fusion: { model_routing: "fuser", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: true, scope: "permanent" },
  summarizer: { enabled: false, model_routing: "turbo", segment_chars: 1400, max_summary_tokens: 256 },
  scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120_000 },
};

function ctx(requestData: Record<string, unknown> = {}): FusionRequestContext {
  return {
    logicalModel: "fusion-beta",
    fusionConfig,
    requestData,
    clientProtocol: "openai",
    messages: [{ role: "user", content: "Plan a complex refactor" }],
  };
}

function score(effort: 1 | 2 | 3, value: number): ComplexityScore {
  return { effort, score: value, reason: "test", tokenCount: 100 };
}

describe("resolveFusionEffort", () => {
  it("caps explicit low requests to F0/F1", () => {
    const decision = resolveFusionEffort(ctx({ reasoning_effort: "low" }), score(3, 0.9));
    expect(decision.resolvedEffort).toBe("F1");
    expect(decision.runtimeEffort).toBe(1);
  });

  it("allows high requests to use F2/F3", () => {
    const decision = resolveFusionEffort(ctx({ fusion_effort: "high" }), score(2, 0.4));
    expect(decision.resolvedEffort).toBe("F2");
    expect(decision.runtimeEffort).toBe(2);
  });

  it("escalates hard image requirements above an explicit low ceiling", () => {
    const imageCtx = ctx({ reasoning_effort: "low" });
    imageCtx.hadImages = true;
    const decision = resolveFusionEffort(imageCtx, score(1, 0.05));
    expect(decision.resolvedEffort).toBe("F2");
    expect(decision.overrideReason).toContain("Escalated");
  });
});
