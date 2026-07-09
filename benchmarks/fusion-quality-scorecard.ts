import { scoreFusionQuality, type FusionQualityScorecardInput } from "../src/routing/fusion/quality-scorecard.ts";

const fixture: FusionQualityScorecardInput = {
  subtasks: [
    {
      focus: "software architecture",
      model: "kimi-k2.7-code",
      description: "Design the TypeScript scheduler adapter and migration path.",
    },
    {
      focus: "mathematical proof",
      model: "glm-5.1-precision",
      description: "Prove starvation freedom using an invariant and ranking function.",
    },
    {
      focus: "algorithmic analysis",
      model: "deepseek-v4-pro",
      description: "Analyze heap aging complexity and priority queue counterexamples.",
    },
    {
      focus: "testing risk",
      model: "minimax-m2.7",
      description: "Identify edge-case tests and rollout risks.",
    },
  ],
  advisories: [
    {
      focus: "software architecture",
      model: "kimi-k2.7-code",
      content: "Recommendation: isolate scheduling policy behind an adapter and migrate call sites incrementally.",
      contextCoveragePercent: 100,
    },
    {
      focus: "mathematical proof",
      model: "glm-5.1-precision",
      content: "Recommendation: prove bounded wait with a rank tuple of priority debt and arrival index.",
      contextCoveragePercent: 100,
    },
    {
      focus: "algorithmic analysis",
      model: "deepseek-v4-pro",
      content: "Recommendation: use heap aging; strict priority queues have starvation counterexamples.",
      contextCoveragePercent: 100,
    },
    {
      focus: "testing risk",
      model: "minimax-m2.7",
      content: "Recommendation: test equal bursts, cancellation during promotion, and persisted replay recovery.",
      contextCoveragePercent: 100,
    },
  ],
  finalPrompt: [
    "Advisory note 1: software architecture via kimi-k2.7-code.",
    "Recommendation: isolate scheduling policy behind an adapter and migrate call sites incrementally.",
    "Advisory note 2: mathematical proof via glm-5.1-precision.",
    "Recommendation: prove bounded wait with a rank tuple of priority debt and arrival index.",
    "Advisory note 3: algorithmic analysis via deepseek-v4-pro.",
    "Recommendation: use heap aging; strict priority queues have starvation counterexamples.",
    "Advisory note 4: testing risk via minimax-m2.7.",
    "Recommendation: test equal bursts, cancellation during promotion, and persisted replay recovery.",
  ].join("\n"),
  finalToolCount: 64,
  subagentRequests: [
    { hasTools: false, toolChoice: "none", stream: true },
    { hasTools: false, toolChoice: "none", stream: true },
    { hasTools: false, toolChoice: "none", stream: true },
    { hasTools: false, toolChoice: "none", stream: true },
  ],
};

const scorecard = scoreFusionQuality(fixture);
console.log(JSON.stringify(scorecard, null, 2));

if (scorecard.overall < 0.95 || scorecard.details.failedChecks.length > 0) {
  process.exitCode = 1;
}
