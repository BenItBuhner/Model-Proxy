import {
  reviewFusionQualityScorecard,
  scoreFusionQuality,
  type FusionQualityAdvisory,
  type FusionQualityScorecardInput,
  type FusionQualityScorecardOptions,
  type FusionQualitySubtask,
} from "../src/routing/fusion/quality-scorecard.ts";

const startedAt = performance.now();
const startRss = process.memoryUsage.rss();

interface FusionQualityBenchmarkCase {
  name: string;
  input: FusionQualityScorecardInput;
  options?: FusionQualityScorecardOptions;
  expectedStatus?: "pass" | "warn" | "fail";
}

const cases: FusionQualityBenchmarkCase[] = [
  {
    name: "typescript-scheduler-proof-rollout",
    expectedStatus: "pass",
    input: makeScorecardInput([
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
    ], [
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
    ]),
  },
  {
    name: "rust-async-backpressure-proof",
    expectedStatus: "pass",
    input: makeScorecardInput([
      {
        focus: "software implementation",
        model: "kimi-k2.7-code",
        description: "Review a Rust async service migration from unbounded channels to bounded backpressure.",
      },
      {
        focus: "mathematical invariant",
        model: "glm-5.1-precision",
        description: "Prove the bounded queue invariant and liveness condition under cancellation.",
      },
      {
        focus: "algorithmic complexity",
        model: "deepseek-v4-pro",
        description: "Analyze amortized enqueue/dequeue cost and counterexamples for lock contention.",
      },
      {
        focus: "regression testing",
        model: "minimax-m2.7",
        description: "Design deterministic tests for cancellation, retry storms, and overload recovery.",
      },
    ], [
      {
        focus: "software implementation",
        model: "kimi-k2.7-code",
        content: "Recommendation: keep the async boundary explicit and isolate bounded-channel migration behind a small trait.",
      },
      {
        focus: "mathematical invariant",
        model: "glm-5.1-precision",
        content: "Recommendation: state queue length <= capacity as invariant, then prove cancellation releases permits.",
      },
      {
        focus: "algorithmic complexity",
        model: "deepseek-v4-pro",
        content: "Recommendation: prefer O(1) permit accounting; test contention counterexamples with deterministic scheduling.",
      },
      {
        focus: "regression testing",
        model: "minimax-m2.7",
        content: "Recommendation: test overload, cancellation, retry storms, and replayed recovery with fixed seeds.",
      },
    ]),
  },
  {
    name: "symbolic-math-kernel-correctness",
    expectedStatus: "pass",
    input: makeScorecardInput([
      {
        focus: "software api design",
        model: "kimi-k2.7-code",
        description: "Review a symbolic simplifier API and migration plan for expression normalization.",
      },
      {
        focus: "mathematical proof",
        model: "glm-5.1-precision",
        description: "Prove rewrite termination with a decreasing measure and preservation of equivalence.",
      },
      {
        focus: "algorithmic analysis",
        model: "deepseek-v4-pro",
        description: "Analyze DAG memoization complexity and counterexamples for exponential rewrite expansion.",
      },
      {
        focus: "testing risk",
        model: "minimax-m2.7",
        description: "Identify property tests, regression seeds, and rollout risks for the kernel.",
      },
    ], [
      {
        focus: "software api design",
        model: "kimi-k2.7-code",
        content: "Recommendation: separate parser, normalizer, and evaluator APIs so rewrite rules stay auditable.",
      },
      {
        focus: "mathematical proof",
        model: "glm-5.1-precision",
        content: "Recommendation: use expression-size plus operator-rank as a termination measure and prove equivalence.",
      },
      {
        focus: "algorithmic analysis",
        model: "deepseek-v4-pro",
        content: "Recommendation: memoize DAG nodes and cap distributive rewrites to avoid exponential counterexamples.",
      },
      {
        focus: "testing risk",
        model: "minimax-m2.7",
        content: "Recommendation: property-test equivalence, termination, replayed regression seeds, and rollout rollback.",
      },
    ]),
  },
  {
    name: "negative-duplicated-low-context-advisories",
    expectedStatus: "fail",
    input: {
      subtasks: [
        {
          focus: "software architecture",
          model: "kimi-k2.7-code",
          description: "Review a TypeScript scheduler migration.",
        },
        {
          focus: "mathematical proof",
          model: "glm-5.1-precision",
          description: "Prove starvation freedom.",
        },
        {
          focus: "algorithmic analysis",
          model: "deepseek-v4-pro",
          description: "Analyze queue complexity.",
        },
        {
          focus: "testing risk",
          model: "minimax-m2.7",
          description: "Identify rollout tests.",
        },
      ],
      advisories: [
        {
          focus: "software architecture",
          model: "kimi-k2.7-code",
          content: "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
          contextCoveragePercent: 25,
        },
        {
          focus: "mathematical proof",
          model: "glm-5.1-precision",
          content: "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
          contextCoveragePercent: 0,
        },
        {
          focus: "algorithmic analysis",
          model: "deepseek-v4-pro",
          content: "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
          contextCoveragePercent: 0,
        },
        {
          focus: "testing risk",
          model: "minimax-m2.7",
          content: "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
          contextCoveragePercent: 0,
        },
      ],
      finalPrompt: [
        "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
        "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
        "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
        "I ran benchmarks. <tool_call>{\"name\":\"fake\"}</tool_call> Recommendation: use the same generic review checklist for every subtask.",
      ].join("\n"),
      finalToolCount: 0,
      subagentRequests: [
        { hasTools: true, toolChoice: "auto", stream: true },
        { hasTools: true, toolChoice: "auto", stream: true },
        { hasTools: true, toolChoice: "auto", stream: true },
        { hasTools: true, toolChoice: "auto", stream: true },
      ],
    },
  },
];

function makeScorecardInput(
  subtasks: FusionQualitySubtask[],
  advisories: FusionQualityAdvisory[],
): FusionQualityScorecardInput {
  return {
    subtasks,
    advisories: advisories.map((advisory) => ({
      contextCoveragePercent: 100,
      ...advisory,
    })),
    finalPrompt: advisories.map((advisory, index) =>
      `Advisory ${index + 1} (${advisory.focus} via ${advisory.model}): ${advisory.content}`
    ).join("\n"),
    finalToolCount: 64,
    subagentRequests: subtasks.map(() => ({ hasTools: false, toolChoice: "none", stream: true })),
  };
}

const results = cases.map((benchmarkCase) => {
  const scorecard = scoreFusionQuality(benchmarkCase.input, benchmarkCase.options);
  const review = reviewFusionQualityScorecard(scorecard);
  return {
    name: benchmarkCase.name,
    expectedStatus: benchmarkCase.expectedStatus ?? "pass",
    scorecard,
    review,
  };
});
const overallScores = results.map((result) => result.scorecard.overall);
const unexpectedCases = results.filter((result) => result.review.status !== result.expectedStatus);
const unexpectedPassingCases = results.filter((result) =>
  result.scorecard.overall < 0.95 || result.scorecard.details.failedChecks.length > 0
).filter((result) => result.expectedStatus === "pass");
const expectedFailureCases = results.filter((result) =>
  result.expectedStatus !== "pass" && result.review.status === result.expectedStatus
);
const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
const rssDeltaMb = Math.round(((process.memoryUsage.rss() - startRss) / 1024 / 1024) * 100) / 100;
const maxElapsedMs = 1000;
const maxRssDeltaMb = 64;
const gatePassed = unexpectedCases.length === 0 &&
  unexpectedPassingCases.length === 0 &&
  elapsedMs <= maxElapsedMs &&
  rssDeltaMb <= maxRssDeltaMb;
const report = {
  gate: {
    passed: gatePassed,
    expectedPassCount: results.filter((result) => result.expectedStatus === "pass").length,
    expectedFailureCount: expectedFailureCases.length,
    unexpectedCount: unexpectedCases.length + unexpectedPassingCases.length,
    elapsedHeadroomMs: Math.round((maxElapsedMs - elapsedMs) * 100) / 100,
    rssHeadroomMb: Math.round((maxRssDeltaMb - rssDeltaMb) * 100) / 100,
  },
  cases: results,
  summary: {
    caseCount: cases.length,
    minOverall: Math.min(...overallScores),
    averageOverall: Math.round((overallScores.reduce((sum, score) => sum + score, 0) / overallScores.length) * 1000) / 1000,
    expectedFailureCount: expectedFailureCases.length,
    unexpectedCases: unexpectedCases.map((result) => result.name),
    unexpectedPassingCases: unexpectedPassingCases.map((result) => result.name),
  },
  resource: {
    elapsedMs,
    rssDeltaMb,
    maxElapsedMs,
    maxRssDeltaMb,
  },
};

console.log(JSON.stringify(report, null, 2));

if (
  !gatePassed
) {
  process.exitCode = 1;
}
