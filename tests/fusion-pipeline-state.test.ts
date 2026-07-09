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

  it("reconstructs completed trace details for historical dashboard views", () => {
    const trace: FusionTraceLike = {
      effort: 2,
      fusionEffort: "F2",
      complexityScore: 0.44,
      complexityReason: "moderate request",
      subTaskCount: 0,
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
        },
      ],
    };

    const state = stateFromTrace(trace);

    expect(state.started?.complexityReason).toBe("moderate request");
    expect(state.phases[0]?.detail?.["reason"]).toBe("moderate request is within synthesis model context");
    expect(state.caches[0]?.hit).toBe(false);
    expect(state.subagents[0]?.detail?.["contextWindow"]).toBe(64_000);
    expect(state.subagents[0]?.detail?.["outputBudgetTokens"]).toBe(16_000);
    expect(state.subagents[0]?.detail?.["contextMessageCount"]).toBe(38);
    expect(state.subagents[0]?.detail?.["droppedMessageCount"]).toBe(102);
  });
});
