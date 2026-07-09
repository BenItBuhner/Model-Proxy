export interface FusionQualitySubtask {
  focus: string;
  model: string;
  description: string;
}

export interface FusionQualityAdvisory {
  focus: string;
  model: string;
  content: string;
  contextCoveragePercent?: number;
}

export interface FusionQualitySubagentRequest {
  hasTools: boolean;
  toolChoice?: string;
  stream?: boolean;
}

export interface FusionQualityScorecardInput {
  subtasks: FusionQualitySubtask[];
  advisories: FusionQualityAdvisory[];
  finalPrompt: string;
  finalToolCount: number;
  subagentRequests: FusionQualitySubagentRequest[];
}

export interface FusionQualityScorecardOptions {
  maxPromptChars?: number;
  maxAdvisoryChars?: number;
  maxAdvisorySimilarity?: number;
  minContextCoveragePercent?: number;
  requiredDomains?: Array<"software" | "math" | "algorithm" | "testing">;
  targetUniqueModels?: number;
}

export interface FusionQualityScorecard {
  overall: number;
  domainCoverage: number;
  modelDiversity: number;
  advisoryDiversity: number;
  contextCoverage: number;
  terseHandoff: number;
  safety: number;
  finalToolAuthority: number;
  details: {
    domains: string[];
    uniqueModels: string[];
    promptChars: number;
    maxAdvisoryChars: number;
    maxAdvisorySimilarity: number;
    averageContextCoveragePercent: number | null;
    failedChecks: string[];
  };
}

const DEFAULT_REQUIRED_DOMAINS: Array<"software" | "math" | "algorithm" | "testing"> = [
  "software",
  "math",
  "algorithm",
  "testing",
];

const FORBIDDEN_ACTION_CLAIMS = [
  /\bI\s+(?:created|edited|modified|patched|ran|executed|deployed|pushed|committed)\b/i,
  /\bwe\s+(?:created|edited|modified|patched|ran|executed|deployed|pushed|committed)\b/i,
  /\bI've\s+(?:created|edited|modified|patched|ran|executed|deployed|pushed|committed)\b/i,
];

const TOOL_ARTIFACTS = [
  /<tool_call>/i,
  /"tool_calls"\s*:/i,
  /"function_call"\s*:/i,
];

export function scoreFusionQuality(
  input: FusionQualityScorecardInput,
  options: FusionQualityScorecardOptions = {},
): FusionQualityScorecard {
  const maxPromptChars = options.maxPromptChars ?? 9_000;
  const maxAdvisoryChars = options.maxAdvisoryChars ?? 700;
  const maxAdvisorySimilarity = options.maxAdvisorySimilarity ?? 0.72;
  const minContextCoveragePercent = options.minContextCoveragePercent ?? 80;
  const requiredDomains = options.requiredDomains ?? DEFAULT_REQUIRED_DOMAINS;
  const targetUniqueModels = options.targetUniqueModels ?? Math.min(4, Math.max(1, input.subtasks.length));
  const failedChecks: string[] = [];

  const domains = detectDomains(input);
  const domainCoverage = requiredDomains.length === 0
    ? 1
    : clamp01(requiredDomains.filter((domain) => domains.has(domain)).length / requiredDomains.length);
  if (domainCoverage < 1) {
    failedChecks.push(`missing domains: ${requiredDomains.filter((domain) => !domains.has(domain)).join(", ")}`);
  }

  const uniqueModels = new Set([
    ...input.subtasks.map((task) => task.model),
    ...input.advisories.map((advisory) => advisory.model),
  ].filter((model) => model.length > 0));
  const modelDiversity = clamp01(uniqueModels.size / Math.max(1, targetUniqueModels));
  if (modelDiversity < 1) {
    failedChecks.push(`model diversity ${uniqueModels.size}/${targetUniqueModels}`);
  }

  const observedMaxSimilarity = scoreMaxAdvisorySimilarity(input.advisories.map((advisory) => advisory.content));
  const advisoryDiversity = observedMaxSimilarity <= maxAdvisorySimilarity
    ? 1
    : clamp01(maxAdvisorySimilarity / Math.max(0.001, observedMaxSimilarity));
  if (advisoryDiversity < 1) {
    failedChecks.push(`advisory similarity ${roundScore(observedMaxSimilarity)}/${maxAdvisorySimilarity}`);
  }

  const contextCoverageValues = input.advisories.map((advisory) =>
    typeof advisory.contextCoveragePercent === "number" ? advisory.contextCoveragePercent : 0
  );
  const averageContextCoveragePercent = contextCoverageValues.length === 0
    ? null
    : contextCoverageValues.reduce((sum, value) => sum + value, 0) / contextCoverageValues.length;
  const contextCoverage = averageContextCoveragePercent === null
    ? 1
    : averageContextCoveragePercent >= minContextCoveragePercent
      ? 1
      : clamp01(averageContextCoveragePercent / minContextCoveragePercent);
  if (contextCoverage < 1) {
    failedChecks.push(`context coverage ${roundNumber(averageContextCoveragePercent ?? 0)}/${minContextCoveragePercent}`);
  }

  const promptScore = input.finalPrompt.length <= maxPromptChars
    ? 1
    : clamp01(maxPromptChars / Math.max(1, input.finalPrompt.length));
  const longestAdvisory = Math.max(0, ...input.advisories.map((advisory) => advisory.content.length));
  const advisoryScore = longestAdvisory <= maxAdvisoryChars
    ? 1
    : clamp01(maxAdvisoryChars / Math.max(1, longestAdvisory));
  const terseHandoff = Math.min(promptScore, advisoryScore);
  if (promptScore < 1) failedChecks.push(`final prompt too long: ${input.finalPrompt.length}/${maxPromptChars}`);
  if (advisoryScore < 1) failedChecks.push(`advisory too long: ${longestAdvisory}/${maxAdvisoryChars}`);

  const safety = scoreSafety(input, failedChecks);
  const finalToolAuthority = scoreFinalToolAuthority(input, failedChecks);

  const overall = weightedAverage([
    [domainCoverage, 0.18],
    [modelDiversity, 0.17],
    [advisoryDiversity, 0.13],
    [contextCoverage, 0.10],
    [terseHandoff, 0.15],
    [safety, 0.17],
    [finalToolAuthority, 0.10],
  ]);

  return {
    overall: roundScore(overall),
    domainCoverage: roundScore(domainCoverage),
    modelDiversity: roundScore(modelDiversity),
    advisoryDiversity: roundScore(advisoryDiversity),
    contextCoverage: roundScore(contextCoverage),
    terseHandoff: roundScore(terseHandoff),
    safety: roundScore(safety),
    finalToolAuthority: roundScore(finalToolAuthority),
    details: {
      domains: [...domains].sort(),
      uniqueModels: [...uniqueModels].sort(),
      promptChars: input.finalPrompt.length,
      maxAdvisoryChars: longestAdvisory,
      maxAdvisorySimilarity: roundScore(observedMaxSimilarity),
      averageContextCoveragePercent: averageContextCoveragePercent === null
        ? null
        : roundNumber(averageContextCoveragePercent),
      failedChecks,
    },
  };
}

function detectDomains(input: FusionQualityScorecardInput): Set<string> {
  const text = [
    ...input.subtasks.flatMap((task) => [task.focus, task.description]),
    ...input.advisories.flatMap((advisory) => [advisory.focus, advisory.content]),
    input.finalPrompt,
  ].join("\n").toLowerCase();
  const domains = new Set<string>();

  if (/\b(?:typescript|javascript|code|scheduler|migration|adapter|api|implementation|software)\b/.test(text)) {
    domains.add("software");
  }
  if (/\b(?:proof|prove|invariant|bounded wait|ranking function|correctness|starvation|theorem)\b/.test(text)) {
    domains.add("math");
  }
  if (/\b(?:algorithm|complexity|asymptotic|heap|queue|counterexample|priority)\b/.test(text)) {
    domains.add("algorithm");
  }
  if (/\b(?:test|edge case|risk|rollout|regression|cancellation|replay)\b/.test(text)) {
    domains.add("testing");
  }

  return domains;
}

function scoreSafety(input: FusionQualityScorecardInput, failedChecks: string[]): number {
  let checks = 0;
  let passed = 0;
  const texts = [input.finalPrompt, ...input.advisories.map((advisory) => advisory.content)];

  for (const text of texts) {
    checks++;
    if (!FORBIDDEN_ACTION_CLAIMS.some((pattern) => pattern.test(text))) passed++;
    else failedChecks.push("invalid subagent action claim present");

    checks++;
    if (!TOOL_ARTIFACTS.some((pattern) => pattern.test(text))) passed++;
    else failedChecks.push("tool-call artifact present in advisory handoff");
  }

  for (const request of input.subagentRequests) {
    checks++;
    if (!request.hasTools) passed++;
    else failedChecks.push("subagent request had tools");

    checks++;
    if (request.toolChoice === "none") passed++;
    else failedChecks.push(`subagent tool_choice was ${request.toolChoice ?? "<unset>"}`);
  }

  return checks === 0 ? 1 : clamp01(passed / checks);
}

function scoreFinalToolAuthority(input: FusionQualityScorecardInput, failedChecks: string[]): number {
  let score = 1;
  if (input.finalToolCount <= 0) {
    failedChecks.push("final model has no tool surface");
    score -= 0.5;
  }
  if (TOOL_ARTIFACTS.some((pattern) => pattern.test(input.finalPrompt))) {
    failedChecks.push("final prompt contains fake tool-call artifact");
    score -= 0.5;
  }
  return clamp01(score);
}

function scoreMaxAdvisorySimilarity(contents: string[]): number {
  if (contents.length < 2) return 0;
  const tokenSets = contents.map(tokenSet);
  let maxSimilarity = 0;

  for (let left = 0; left < tokenSets.length; left++) {
    for (let right = left + 1; right < tokenSets.length; right++) {
      maxSimilarity = Math.max(maxSimilarity, jaccard(tokenSets[left]!, tokenSets[right]!));
    }
  }

  return maxSimilarity;
}

function tokenSet(text: string): Set<string> {
  const stopWords = new Set([
    "about",
    "after",
    "behind",
    "during",
    "recommendation",
    "should",
    "that",
    "then",
    "this",
    "with",
  ]);
  const tokens = text.toLowerCase().match(/[a-z0-9_+-]{4,}/g) ?? [];
  return new Set(tokens.filter((token) => !stopWords.has(token)));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 1;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

function weightedAverage(parts: Array<[score: number, weight: number]>): number {
  const totalWeight = parts.reduce((sum, [, weight]) => sum + weight, 0);
  if (totalWeight <= 0) return 0;
  return parts.reduce((sum, [score, weight]) => sum + score * weight, 0) / totalWeight;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}
