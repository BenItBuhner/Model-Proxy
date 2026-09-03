/** Shared types for the kernel benchmark harness. */

export type ItemKind = "numeric" | "mc" | "code" | "yesno" | "open";

export type Domain = "math" | "science" | "swe" | "finance" | "legal" | "creativity" | "reasoning";

export interface BenchItem {
  /** Stable id: `${suite}:${index}`. */
  id: string;
  suite: string;
  domain: Domain;
  kind: ItemKind;
  /** Chat messages sent identically to every model. */
  messages: Array<{ role: "system" | "user"; content: string }>;
  /** Ground truth (numeric/mc/yesno) or test harness (code) — absent for open items. */
  answer?: string;
  /** For code items: python test source + entry point. */
  code?: { prompt: string; test: string; entryPoint: string };
  meta?: Record<string, unknown>;
}

export interface ModelRun {
  itemId: string;
  suite: string;
  domain: Domain;
  kind: ItemKind;
  model: string;
  ok: boolean;
  /** Parsed final answer (numeric/mc/yesno) or "pass"/"fail" for code. */
  predicted?: string;
  expected?: string;
  correct?: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Full response text (bounded). */
  content: string;
  error?: string;
  kernel?: Record<string, unknown>;
  at: string;
  /** Harness/prompt version, so old rows can be excluded after prompt changes. */
  version: number;
}

export const RUN_VERSION = 1;
