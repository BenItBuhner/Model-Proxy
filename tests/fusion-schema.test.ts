import { describe, it, expect } from "bun:test";
import { FusionConfigSchema } from "../shared/schemas/fusion.ts";
import { ModelRoutingConfigSchema } from "../shared/schemas/routing.ts";

describe("Fusion Config Schema", () => {
  it("parses the fusion-beta.json config correctly", () => {
    const raw = {
      logical_name: "fusion-beta",
      timeout_seconds: 120,
      default_cooldown_seconds: 0,
      model_routings: [{ provider: "openai", model: "fusion-placeholder" }],
      fallback_model_routings: [],
      fusion: {
        enabled: true,
        context_window: 10_000_000,
        task_divider: { model_routing: "glm-5.2", timeout_seconds: 60, max_subtasks: 10 },
        effort_levels: {
          1: { model_routing: "glm-5.2" },
          2: {
            subagent_count: { min: 2, max: 4 },
            model_routings: ["glm-5.2", "kimi-k2.7-code", "minimax-m3-free"],
          },
          3: {
            subagent_count: { min: 4, max: 8 },
            model_routings: ["glm-5.2", "kimi-k2.7-code", "minimax-m3-free", "nemotron-3-ultra", "greg-2-ultra"],
          },
        },
        fusion: { model_routing: "glm-5.2", strategy: "sequential_append", wire_protocol: "openai" },
        cache: { enabled: true, scope: "permanent" },
      },
    };
    const parsed = ModelRoutingConfigSchema.parse(raw);

    expect(parsed.logical_name).toBe("fusion-beta");
    expect(parsed.fusion?.enabled).toBe(true);
    expect(parsed.fusion?.context_window).toBe(10_000_000);
    expect(parsed.fusion?.task_divider.model_routing).toBe("glm-5.2");
    expect(parsed.fusion?.effort_levels[1].model_routing).toBe("glm-5.2");
    expect(parsed.fusion?.effort_levels[2]?.model_routings).toEqual(["glm-5.2", "kimi-k2.7-code", "minimax-m3-free"]);
    expect(parsed.fusion?.effort_levels[3]?.model_routings).toEqual(["glm-5.2", "kimi-k2.7-code", "minimax-m3-free", "nemotron-3-ultra", "greg-2-ultra"]);
    expect(parsed.fusion?.effort_levels[2]?.tools).toEqual([]);
    expect(parsed.fusion?.effort_levels[3]?.tools).toEqual([]);
    expect(parsed.fusion?.fusion.model_routing).toBe("glm-5.2");
    expect(parsed.fusion?.fusion.wire_protocol).toBe("openai");
    expect(parsed.fusion?.cache.enabled).toBe(true);
    expect(parsed.fusion?.scheduler.allow_nested_fusion).toBe(false);
  });

  it("validates complexity scoring thresholds", () => {
    const valid = FusionConfigSchema.parse({
      enabled: true,
      context_window: 5_000_000,
      complexity_scoring: {
        effort_1_threshold: 0.1,
        effort_2_threshold: 0.6,
      },
      task_divider: { model_routing: "complete" },
      effort_levels: {
        1: { model_routing: "turbo" },
        2: {
          subagent_count: { min: 2, max: 4 },
          model_routings: ["complete"],
          tools: ["context_search"],
        },
        3: {
          subagent_count: { min: 4, max: 8 },
          model_routings: ["complete"],
          tools: ["context_search", "code_execution"],
        },
      },
      fusion: {
        model_routing: "complete",
        strategy: "sequential_append",
        wire_protocol: "openai",
      },
      cache: { enabled: true, scope: "permanent" },
      scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120_000 },
    });

    expect(valid.complexity_scoring.effort_1_threshold).toBe(0.1);
    expect(valid.complexity_scoring.effort_2_threshold).toBe(0.6);
  });

  it("applies defaults for optional fields", () => {
    const minimal = FusionConfigSchema.parse({
      enabled: true,
      effort_levels: {
        1: { model_routing: "turbo" },
      },
      fusion: {
        model_routing: "complete",
      },
    });

    expect(minimal.context_window).toBe(10_000_000);
    expect(minimal.complexity_scoring.effort_1_threshold).toBe(0.15);
    expect(minimal.complexity_scoring.effort_2_threshold).toBe(0.45);
    expect(minimal.task_divider.model_routing).toBe("glm-5.2");
    expect(minimal.task_divider.max_subtasks).toBe(10);
    expect(minimal.fusion.strategy).toBe("sequential_append");
    expect(minimal.fusion.wire_protocol).toBe("openai");
    expect(minimal.cache.enabled).toBe(true);
    expect(minimal.scheduler.allow_nested_fusion).toBe(false);
  });

  it("accepts legacy effort tools but normal runtime ignores them", () => {
    const parsed = FusionConfigSchema.parse({
      enabled: true,
      effort_levels: {
        1: { model_routing: "turbo" },
        2: {
          subagent_count: { min: 2, max: 4 },
          model_routings: ["complete"],
          tools: ["context_search"],
        },
        3: {
          subagent_count: { min: 4, max: 8 },
          model_routings: ["complete"],
          tools: ["context_search", "code_execution"],
        },
      },
      fusion: { model_routing: "complete" },
    });

    expect(parsed.effort_levels[2]?.tools).toEqual(["context_search"]);
    expect(parsed.effort_levels[3]?.tools).toEqual(["context_search", "code_execution"]);
  });

  it("validates effort 1 thresholds must be <= effort 2 thresholds", () => {
    expect(() =>
      FusionConfigSchema.parse({
        enabled: true,
        complexity_scoring: {
          effort_1_threshold: 0.8,
          effort_2_threshold: 0.3, // Invalid: 0.8 > 0.3
        },
        effort_levels: {
          1: { model_routing: "turbo" },
        },
        fusion: { model_routing: "complete" },
      })
    ).toThrow();
  });

  it("validates subagent min must be <= max", () => {
    expect(() =>
      FusionConfigSchema.parse({
        enabled: true,
        effort_levels: {
          1: { model_routing: "turbo" },
          2: {
            subagent_count: { min: 5, max: 2 },
            model_routings: ["complete"],
          },
        },
        fusion: { model_routing: "complete" },
      })
    ).toThrow();
  });
});
