import { z } from "zod";
export const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const ReasoningEffortSchema = z.enum(REASONING_EFFORTS);
const MIN_THINKING_BUDGET_TOKENS = 1024;
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}
export function asReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(value) ? value : undefined;
}
export function reasoningEffortToBudget(effort: ReasoningEffort): number {
  switch (effort) {
    case "minimal":
      return 1024;
    case "low":
      return 2048;
    case "medium":
      return 8192;
    case "high":
      return 16384;
  }
}
export function budgetToReasoningEffort(budgetTokens: number): ReasoningEffort {
  if (budgetTokens <= 2048) return "low";
  if (budgetTokens <= 8192) return "medium";
  return "high";
}
export function thinkingFromReasoningEffort(
  effort: ReasoningEffort,
  maxTokens?: number,
): { type: "enabled"; budget_tokens: number } | undefined {
  const requested = reasoningEffortToBudget(effort);
  if (typeof maxTokens !== "number" || !Number.isFinite(maxTokens) || maxTokens <= 0) {
    return { type: "enabled", budget_tokens: requested };
  }
  const budget = Math.min(requested, Math.floor(maxTokens) - 1);
  if (budget < MIN_THINKING_BUDGET_TOKENS) return undefined;
  return { type: "enabled", budget_tokens: budget };
}
export function reasoningEffortFromThinking(thinking: unknown): ReasoningEffort | undefined {
  if (typeof thinking !== "object" || thinking === null) return undefined;
  const t = thinking as Record<string, unknown>;
  if (t["type"] !== "enabled") return undefined;
  const budget = t["budget_tokens"];
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) return undefined;
  return budgetToReasoningEffort(budget);
}
export function reasoningEffortFromReasoningObject(reasoning: unknown): ReasoningEffort | undefined {
  if (typeof reasoning !== "object" || reasoning === null) return undefined;
  return asReasoningEffort((reasoning as Record<string, unknown>)["effort"]);
}
