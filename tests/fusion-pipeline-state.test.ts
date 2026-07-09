import { describe, expect, it } from "bun:test";
import {
  derivePipelineState,
  stateFromTrace,
  type FusionTraceLike,
} from "../web/components/observability/fusion-pipeline-state.ts";
import type { RequestEvent } from "../web/lib/test-events.ts";

describe("fusion pipeline state derivation", () => {
  it("merges live subagent progress detail into the completed lane", () => {
    const events: RequestEvent[] = [
      {
        type: "fusion.pipeline.started",
        at: "2026-07-09T00:00:00.000Z",
        effort: 2,
        fusionEffort: "F2",
        complexityScore: 0.55,
        complexityReason: "many tools",
        logicalModel: "fusion-beta",
        stream: true,
      },
      {
        type: "fusion.phase",
        at: "2026-07-09T00:00:00.100Z",
        phase: "subagent_execution",
        status: "started",
        detail: { count: 1 },
      },
      {
        type: "fusion.subagent",
        at: "2026-07-09T00:00:00.200Z",
        id: "research-1",
        focus: "repository",
        model: "glm-5.2",
        status: "progress",
        attempt: 1,
        detail: {
          stage: "context_pack",
          contextWindow: 64_000,
          inputBudgetTokens: 48_000,
          outputBudgetTokens: 16_000,
          contextMessageCount: 38,
          droppedMessageCount: 102,
          packedContextTokens: 11_819,
        },
      },
      {
        type: "fusion.subagent",
        at: "2026-07-09T00:00:01.000Z",
        id: "research-1",
        focus: "repository",
        model: "glm-5.2",
        status: "completed",
        attempt: 1,
        chars: 800,
        durationMs: 800,
      },
      {
        type: "fusion.phase",
        at: "2026-07-09T00:00:01.100Z",
        phase: "subagent_execution",
        status: "completed",
        durationMs: 900,
        detail: { succeeded: 1 },
      },
    ];

    const state = derivePipelineState(events);

    expect(state.started?.fusionEffort).toBe("F2");
    expect(state.phases.find((phase) => phase.key === "subagent_execution")?.detail).toEqual({
      count: 1,
      succeeded: 1,
    });
    expect(state.subagents[0]?.status).toBe("completed");
    expect(state.subagents[0]?.detail?.["contextWindow"]).toBe(64_000);
    expect(state.subagents[0]?.detail?.["inputBudgetTokens"]).toBe(48_000);
    expect(state.subagents[0]?.detail?.["contextMessageCount"]).toBe(38);
    expect(state.subagents[0]?.detail?.["droppedMessageCount"]).toBe(102);
    expect(state.subagents[0]?.chars).toBe(800);
  });

  it("keeps context metrics when only the terminal subagent event is available", () => {
    const events: RequestEvent[] = [
      {
        type: "fusion.subagent",
        at: "2026-07-09T00:00:01.000Z",
        id: "research-1",
        focus: "repository",
        model: "glm-5.2",
        status: "completed",
        attempt: 1,
        chars: 800,
        durationMs: 800,
        detail: {
          stage: "completed",
          contextWindow: 64_000,
          inputBudgetTokens: 48_000,
          outputBudgetTokens: 16_000,
          contextMessageCount: 38,
          droppedMessageCount: 102,
          packedContextTokens: 11_819,
        },
      },
    ];

    const state = derivePipelineState(events);

    expect(state.subagents[0]?.status).toBe("completed");
    expect(state.subagents[0]?.detail?.["stage"]).toBe("completed");
    expect(state.subagents[0]?.detail?.["contextWindow"]).toBe(64_000);
    expect(state.subagents[0]?.detail?.["droppedMessageCount"]).toBe(102);
    expect(state.subagents[0]?.detail?.["packedContextTokens"]).toBe(11_819);
  });

  it("renders cached subagent reuse as completed live lanes", () => {
    const events: RequestEvent[] = [
      {
        type: "fusion.phase",
        at: "2026-07-09T00:00:00.100Z",
        phase: "subagent_execution",
        status: "completed",
        detail: {
          decision: "reuse",
          cacheKind: "request",
          cacheKey: "cache-123",
          total: 1,
          succeeded: 1,
        },
      },
      {
        type: "fusion.subagent",
        at: "2026-07-09T00:00:00.200Z",
        id: "research-1",
        focus: "repository",
        model: "glm-5.2",
        status: "completed",
        chars: 1200,
        durationMs: 830,
        detail: {
          stage: "cache_reused",
          cacheKind: "request",
          cacheKey: "cache-123",
          contextWindow: 64_000,
          inputBudgetTokens: 48_000,
          outputBudgetTokens: 16_000,
        },
      },
    ];

    const state = derivePipelineState(events);

    expect(state.phases[0]?.detail?.["decision"]).toBe("reuse");
    expect(state.phases[0]?.detail?.["cacheKind"]).toBe("request");
    expect(state.subagents[0]?.status).toBe("completed");
    expect(state.subagents[0]?.detail?.["stage"]).toBe("cache_reused");
    expect(state.subagents[0]?.detail?.["cacheKey"]).toBe("cache-123");
    expect(state.subagents[0]?.detail?.["inputBudgetTokens"]).toBe(48_000);
  });

  it("reconstructs completed trace details for historical dashboard views", () => {
    const trace: FusionTraceLike = {
      effort: 2,
      fusionEffort: "F2",
      complexityScore: 0.44,
      complexityReason: "moderate request",
      subTaskCount: 0,
      subTasks: [
        {
          id: "research-1",
          focus: "repository",
          model: "glm-5.2",
          description: "Analyze repository cleanup risk and verification scope.",
        },
      ],
      summaries: [
        {
          label: "research-1 · repository",
          text: "Repository cleanup risks are being checked before synthesis.",
          at: "2026-07-09T00:00:02.000Z",
        },
      ],
      cacheHit: false,
      totalTokens: 120,
      fusedByModelRouting: "glm-5.2",
      steps: [
        {
          type: "subagent_execution",
          label: "Subagent Execution Skipped",
          durationMs: 0,
          details: {
            useSubagents: false,
            reason: "moderate request is within synthesis model context",
          },
        },
      ],
      subagentDetails: [
        {
          id: "research-1",
          focus_area: "repository",
          success: true,
          modelRouting: "glm-5.2",
          durationMs: 900,
          outputLength: 1200,
          contextWindow: 64_000,
          inputBudgetTokens: 48_000,
          outputBudgetTokens: 16_000,
          contextMessageCount: 38,
          droppedMessageCount: 102,
          packedContextTokens: 11_819,
          contextPack: {
            logicalContextWindow: 10_000_000,
            tokenBudget: 48_000,
            totalMessages: 140,
            suppliedMessages: 38,
            droppedMessages: 102,
            coveragePercent: 27.1,
            selectedRanges: "1-3,42,60,103-140",
            relevantHitCount: 12,
            mix: {
              first: 3,
              relevant: 8,
              anchors: 4,
              recent: 38,
            },
          },
        },
      ],
    };

    const state = stateFromTrace(trace);

    expect(state.started?.complexityReason).toBe("moderate request");
    expect(state.subTasks[0]).toEqual({
      id: "research-1",
      focus: "repository",
      model: "glm-5.2",
      description: "Analyze repository cleanup risk and verification scope.",
    });
    expect(state.summaries[0]).toEqual({
      label: "research-1 · repository",
      text: "Repository cleanup risks are being checked before synthesis.",
      at: "2026-07-09T00:00:02.000Z",
    });
    expect(state.phases[0]?.detail?.["reason"]).toBe("moderate request is within synthesis model context");
    expect(state.caches[0]?.hit).toBe(false);
    expect(state.subagents[0]?.detail?.["contextWindow"]).toBe(64_000);
    expect(state.subagents[0]?.detail?.["outputBudgetTokens"]).toBe(16_000);
    expect(state.subagents[0]?.detail?.["contextMessageCount"]).toBe(38);
    expect(state.subagents[0]?.detail?.["droppedMessageCount"]).toBe(102);
    expect((state.subagents[0]?.detail?.["contextPack"] as Record<string, unknown> | undefined)?.["selectedRanges"]).toBe("1-3,42,60,103-140");
  });

  it("preserves streaming trace step detail in historical dashboard views", () => {
    const trace: FusionTraceLike = {
      effort: 2,
      fusionEffort: "F2",
      complexityScore: 0.39,
      complexityReason: "resolved within synthesis context",
      subTaskCount: 0,
      cacheHit: false,
      totalTokens: 80,
      fusedByModelRouting: "glm-5.2",
      steps: [
        {
          type: "subagent_execution",
          label: "Subagent Execution Skipped",
          durationMs: 0,
          detail: {
            useSubagents: false,
            reason: "moderate request is within synthesis model context",
            largeContext: false,
          },
        },
      ],
    };

    const state = stateFromTrace(trace);

    expect(state.phases[0]?.key).toBe("subagent_execution");
    expect(state.phases[0]?.detail?.["useSubagents"]).toBe(false);
    expect(state.phases[0]?.detail?.["reason"]).toBe("moderate request is within synthesis model context");
  });

  it("preserves adaptive subagent decision metrics for historical dashboard views", () => {
    const trace: FusionTraceLike = {
      effort: 2,
      fusionEffort: "F2",
      complexityScore: 0.45,
      complexityReason: "long focused transcript",
      subTaskCount: 0,
      cacheHit: false,
      totalTokens: 30000,
      fusedByModelRouting: "glm-5.2",
      steps: [
        {
          type: "subagent_execution",
          label: "Subagent Execution Skipped",
          durationMs: 0,
          detail: {
            useSubagents: false,
            reason: "moderate request is within synthesis model context; subagents would add latency without clear benefit",
            tokenCount: 30000,
            activeFusionContextWindow: 128000,
            declaredFusionContextWindow: 128000,
            largeContextThreshold: 44800,
            largeContext: false,
            toolCount: 0,
            toolUseAllowed: false,
            messageCount: 4,
            referencedFileCount: 0,
          },
        },
      ],
    };

    const state = stateFromTrace(trace);
    const detail = state.phases[0]?.detail;

    expect(detail?.["useSubagents"]).toBe(false);
    expect(detail?.["activeFusionContextWindow"]).toBe(128000);
    expect(detail?.["largeContextThreshold"]).toBe(44800);
    expect(detail?.["largeContext"]).toBe(false);
    expect(detail?.["toolUseAllowed"]).toBe(false);
  });

  it("reconstructs cache lookup steps as cache phases instead of scoring phases", () => {
    const trace: FusionTraceLike = {
      effort: 3,
      fusionEffort: "F3",
      complexityScore: 0.82,
      complexityReason: "large tool-heavy request",
      subTaskCount: 2,
      cacheHit: true,
      cacheKey: "abc123",
      totalTokens: 200,
      fusedByModelRouting: "glm-5.2",
      steps: [
        {
          type: "cache_lookup",
          label: "Conversation Reuse",
          durationMs: 0,
          detail: {
            hit: true,
            deltaCount: 1,
            reason: "assistant-only continuation",
          },
        },
      ],
    };

    const state = stateFromTrace(trace);

    expect(state.phases[0]?.key).toBe("cache_lookup");
    expect(state.phases[0]?.detail?.["hit"]).toBe(true);
    expect(state.phases[0]?.detail?.["reason"]).toBe("assistant-only continuation");
    expect(state.caches[0]?.hit).toBe(true);
  });
});
