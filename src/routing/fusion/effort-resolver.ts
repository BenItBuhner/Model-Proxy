import type {
  ComplexityScore,
  FusionEffortLevel,
  FusionRequestContext,
  RequestedReasoningEffort,
} from "./types.ts";

export interface FusionEffortDecision {
  requestedEffort: RequestedReasoningEffort;
  recommendedEffort: FusionEffortLevel;
  resolvedEffort: FusionEffortLevel;
  runtimeEffort: 1 | 2 | 3;
  overrideReason?: string;
}

export function resolveFusionEffort(
  ctx: FusionRequestContext,
  score: ComplexityScore,
): FusionEffortDecision {
  const requestedEffort = parseRequestedEffort(ctx.requestData);
  const recommendedEffort = recommendEffort(ctx, score);
  const hardMinimum = hardMinimumEffort(ctx);
  const [floor, ceiling] = effortBand(requestedEffort);
  let resolvedEffort = clampEffort(recommendedEffort, floor, ceiling);
  let overrideReason: string | undefined;

  if (compareEffort(hardMinimum, resolvedEffort) > 0) {
    resolvedEffort = hardMinimum;
    overrideReason = `Escalated to ${hardMinimum} for hard request requirements.`;
  }

  return {
    requestedEffort,
    recommendedEffort,
    resolvedEffort,
    runtimeEffort: runtimeEffortFor(resolvedEffort),
    overrideReason,
  };
}

function parseRequestedEffort(requestData: Record<string, unknown>): RequestedReasoningEffort {
  const raw = requestData["fusion_effort"] ?? requestData["reasoning_effort"] ?? "auto";
  if (typeof raw !== "string") return "auto";
  const normalized = raw.toLowerCase();
  if (normalized === "low" || normalized === "medium" || normalized === "high" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

function recommendEffort(ctx: FusionRequestContext, score: ComplexityScore): FusionEffortLevel {
  if (score.effort === 3) return "F3";
  if (score.effort === 2) return "F2";
  const lowThreshold = ctx.fusionConfig.complexity_scoring.effort_1_threshold / 2;
  return score.score <= lowThreshold ? "F0" : "F1";
}

function hardMinimumEffort(ctx: FusionRequestContext): FusionEffortLevel {
  if (ctx.hadImages || (ctx.imageDescriptions?.length ?? 0) > 0) return "F2";
  return "F0";
}

function effortBand(requested: RequestedReasoningEffort): [FusionEffortLevel, FusionEffortLevel] {
  switch (requested) {
    case "low":
      return ["F0", "F1"];
    case "medium":
      return ["F1", "F2"];
    case "high":
      return ["F2", "F3"];
    case "auto":
      return ["F0", "F3"];
  }
}

function clampEffort(
  effort: FusionEffortLevel,
  floor: FusionEffortLevel,
  ceiling: FusionEffortLevel,
): FusionEffortLevel {
  if (compareEffort(effort, floor) < 0) return floor;
  if (compareEffort(effort, ceiling) > 0) return ceiling;
  return effort;
}

function compareEffort(a: FusionEffortLevel, b: FusionEffortLevel): number {
  return effortRank(a) - effortRank(b);
}

function effortRank(effort: FusionEffortLevel): number {
  switch (effort) {
    case "F0":
      return 0;
    case "F1":
      return 1;
    case "F2":
      return 2;
    case "F3":
      return 3;
  }
}

function runtimeEffortFor(effort: FusionEffortLevel): 1 | 2 | 3 {
  switch (effort) {
    case "F0":
    case "F1":
      return 1;
    case "F2":
      return 2;
    case "F3":
      return 3;
  }
}
