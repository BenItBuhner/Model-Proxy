import { describe, expect, it } from "bun:test";
import { scoreFusionQuality, type FusionQualityScorecardInput } from "../src/routing/fusion/quality-scorecard.ts";

function strongInput(): FusionQualityScorecardInput {
  return {
    subtasks: [
      { focus: "software architecture", model: "kimi-k2.7-code", description: "Design the TypeScript scheduler migration adapter." },
      { focus: "mathematical proof", model: "glm-5.1-precision", description: "Prove bounded wait using an invariant and ranking function." },
      { focus: "algorithmic analysis", model: "deepseek-v4-pro", description: "Analyze heap aging complexity and queue counterexamples." },
      { focus: "testing risk", model: "minimax-m2.7", description: "Identify edge-case tests and rollout risks." },
    ],
    advisories: [
      {
        focus: "software architecture",
        model: "kimi-k2.7-code",
        content: "Recommendation: use an adapter boundary for scheduler migration.",
        contextCoveragePercent: 100,
      },
      {
        focus: "mathematical proof",
        model: "glm-5.1-precision",
        content: "Recommendation: prove starvation freedom with a decreasing rank tuple.",
        contextCoveragePercent: 100,
      },
      {
        focus: "algorithmic analysis",
        model: "deepseek-v4-pro",
        content: "Recommendation: use heap aging and reject strict priority queues.",
        contextCoveragePercent: 100,
      },
      {
        focus: "testing risk",
        model: "minimax-m2.7",
        content: "Recommendation: test equal bursts, cancellation, replay, and rollout recovery.",
        contextCoveragePercent: 100,
      },
    ],
    finalPrompt: [
      "Software: use an adapter boundary for scheduler migration.",
      "Math: prove starvation freedom with a decreasing rank tuple and bounded wait invariant.",
      "Algorithm: use heap aging and reject strict priority queue counterexamples.",
      "Testing: cover equal bursts, cancellation, replay, and rollout recovery.",
    ].join("\n"),
    finalToolCount: 64,
    subagentRequests: [
      { hasTools: false, toolChoice: "none", stream: true },
      { hasTools: false, toolChoice: "none", stream: true },
      { hasTools: false, toolChoice: "none", stream: true },
      { hasTools: false, toolChoice: "none", stream: true },
    ],
  };
}

describe("scoreFusionQuality", () => {
  it("scores strong SWE/math Fusion traces near perfect", () => {
    const scorecard = scoreFusionQuality(strongInput());

    expect(scorecard.overall).toBeGreaterThanOrEqual(0.95);
    expect(scorecard.domainCoverage).toBe(1);
    expect(scorecard.modelDiversity).toBe(1);
    expect(scorecard.advisoryDiversity).toBe(1);
    expect(scorecard.contextCoverage).toBe(1);
    expect(scorecard.terseHandoff).toBe(1);
    expect(scorecard.safety).toBe(1);
    expect(scorecard.finalToolAuthority).toBe(1);
    expect(scorecard.details.failedChecks).toEqual([]);
  });

  it("penalizes unsafe, verbose, low-diversity traces", () => {
    const weak = strongInput();
    weak.subtasks = weak.subtasks.map((task) => ({ ...task, model: "glm-5.2" }));
    weak.advisories = [{
      focus: "software",
      model: "glm-5.2",
      content: `I created files and ran benchmarks. ${"extra detail ".repeat(900)} <tool_call>{"name":"fake"}</tool_call>`,
    }];
    weak.finalPrompt = weak.advisories[0]!.content;
    weak.finalToolCount = 0;
    weak.subagentRequests = [{ hasTools: true, toolChoice: "auto", stream: true }];

    const scorecard = scoreFusionQuality(weak);

    expect(scorecard.overall).toBeLessThan(0.7);
    expect(scorecard.safety).toBeLessThan(1);
    expect(scorecard.terseHandoff).toBeLessThan(1);
    expect(scorecard.finalToolAuthority).toBeLessThan(1);
    expect(scorecard.details.failedChecks.length).toBeGreaterThan(0);
  });

  it("penalizes duplicated advisories and missing context coverage even with varied model labels", () => {
    const weak = strongInput();
    weak.advisories = weak.advisories.map((advisory, index) => ({
      ...advisory,
      content: `Recommendation: use the same generic review checklist for every subtask ${index}.`,
      contextCoveragePercent: index === 0 ? 100 : 0,
    }));
    weak.finalPrompt = weak.advisories.map((advisory) => advisory.content).join("\n");

    const scorecard = scoreFusionQuality(weak);

    expect(scorecard.modelDiversity).toBe(1);
    expect(scorecard.advisoryDiversity).toBeLessThan(1);
    expect(scorecard.contextCoverage).toBeLessThan(1);
    expect(scorecard.overall).toBeLessThan(0.95);
    expect(scorecard.details.failedChecks).toContain("context coverage 25/80");
    expect(scorecard.details.failedChecks.some((check) => check.startsWith("advisory similarity"))).toBe(true);
  });
});
