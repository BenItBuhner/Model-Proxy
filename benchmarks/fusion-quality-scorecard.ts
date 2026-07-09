import {
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
}

const cases: FusionQualityBenchmarkCase[] = [
  {
    name: "typescript-scheduler-proof-rollout",
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
];

function makeScorecardInput(
  subtasks: FusionQualitySubtask[],
  advisories: FusionQualityAdvisory[],
): FusionQualityScorecardInput {
  return {
    subtasks,
    advisories,
    finalPrompt: advisories.map((advisory, index) =>
      `Advisory ${index + 1} (${advisory.focus} via ${advisory.model}): ${advisory.content}`
    ).join("\n"),
    finalToolCount: 64,
    subagentRequests: subtasks.map(() => ({ hasTools: false, toolChoice: "none", stream: true })),
  };
}

const results = cases.map((benchmarkCase) => ({
  name: benchmarkCase.name,
  scorecard: scoreFusionQuality(benchmarkCase.input, benchmarkCase.options),
}));
const overallScores = results.map((result) => result.scorecard.overall);
const failedCases = results.filter((result) =>
  result.scorecard.overall < 0.95 || result.scorecard.details.failedChecks.length > 0
);
const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
const rssDeltaMb = Math.round(((process.memoryUsage.rss() - startRss) / 1024 / 1024) * 100) / 100;
const report = {
  cases: results,
  summary: {
    caseCount: cases.length,
    minOverall: Math.min(...overallScores),
    averageOverall: Math.round((overallScores.reduce((sum, score) => sum + score, 0) / overallScores.length) * 1000) / 1000,
    failedCases: failedCases.map((result) => result.name),
  },
  resource: {
    elapsedMs,
    rssDeltaMb,
    maxElapsedMs: 1000,
    maxRssDeltaMb: 64,
  },
};

console.log(JSON.stringify(report, null, 2));

if (
  failedCases.length > 0 ||
  elapsedMs > report.resource.maxElapsedMs ||
  rssDeltaMb > report.resource.maxRssDeltaMb
) {
  process.exitCode = 1;
}
