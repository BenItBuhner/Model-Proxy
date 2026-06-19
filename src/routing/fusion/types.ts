import type { FusionConfig } from "../../../shared/schemas/fusion.ts";

// ── Effort Levels ─────────────────────────────────────────────────────

export type EffortLevel = 1 | 2 | 3;

// ── Fusion Request Context ────────────────────────────────────────────

/**
 * The full context needed to execute a fusion request.
 * Carries the original request data, the resolved fusion config,
 * and the target wire protocol for the response.
 */
export interface FusionRequestContext {
  /** The logical model name the client requested (e.g. "fusion-beta"). */
  logicalModel: string;
  /** Resolved fusion configuration from the model config. */
  fusionConfig: FusionConfig;
  /** The parsed request body (OpenAI or Anthropic format). */
  requestData: Record<string, unknown>;
  /** The wire protocol the client is speaking. */
  clientProtocol: "openai" | "anthropic";
  /** Messages array extracted from requestData. */
  messages: unknown[];
  /** Abort signal for cancellation. */
  signal?: AbortSignal;
}

// ── Sub-task / Subagent Types ─────────────────────────────────────────

/**
 * A divided sub-task produced by the TaskDividerAgent.
 */
export interface SubTask {
  id: string;
  description: string;
  focus_area: string;
  /** The existing model routing to use for this sub-task (e.g. "complete"). */
  suggested_model_routing: string;
}

/**
 * The result of executing a single subagent.
 */
export interface SubagentResult {
  subTask: SubTask;
  success: boolean;
  /** The model routing that was actually used. */
  usedModelRouting: string;
  /** The raw response content from the subagent. */
  content: string;
  /** Any tool calls made by the subagent. */
  toolCalls?: unknown[];
  /** Error message if failed. */
  error?: string;
  durationMs: number;
}

// ── Complexity Score Result ──────────────────────────────────────────

export interface ComplexityScore {
  score: number; // 0-1
  effort: EffortLevel;
  reason: string;
  tokenCount: number;
}

// ── Reasoning Summary Event (for SSE streaming) ──────────────────────

export interface ReasoningSummaryEvent {
  type: "reasoning";
  summary: string;
  subagent_id?: string;
  goalpost_type?: string;
}

// ── Fusion Result ─────────────────────────────────────────────────────

/**
 * The final result of a fusion request.
 */
export interface FusionResult {
  /** The final response content (from the fusion synthesis model). */
  content: string;
  /** The wire protocol the response is formatted in. */
  wireProtocol: "openai" | "anthropic";
  /** All subagent results (for cache/storage). */
  subagentResults: SubagentResult[];
  /** Final model that produced the fused response. */
  fusedByModelRouting: string;
  /** Usage / token tracking. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

// ── Cache Types ───────────────────────────────────────────────────────

export interface FusionCacheEntry {
  /** Hash key identifying the request. */
  key: string;
  /** Stored subagent results for reconstruction. */
  subagentResults: SubagentResult[];
  /** The divided sub-tasks that produced these results. */
  subTasks: SubTask[];
  /** The complexity score that was computed. */
  complexityScore: ComplexityScore;
  /** Timestamp of creation. */
  createdAt: string;
  /** The final fused content. */
  fusedContent?: string;
}

// ── Goalpost Event ──────────────────────────────────────────────────

export interface GoalpostEvent {
  type: string;
  subagentId?: string;
  transcriptPortion: string;
  timestamp: string;
}

// ── Resolved subagent route ──────────────────────────────────────────

/**
 * A resolved route for a subagent, referencing an existing model routing.
 */
export interface SubagentRoute {
  logicalModel: string;
  subTask: SubTask;
}
