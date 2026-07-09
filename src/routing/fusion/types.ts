import type { FusionConfig } from "../../../shared/schemas/fusion.ts";
import type { Principal } from "../../storage/identity-store.ts";

// ── Effort Levels ─────────────────────────────────────────────────────

export type EffortLevel = 1 | 2 | 3;
export type FusionEffortLevel = "F0" | "F1" | "F2" | "F3";
export type RequestedReasoningEffort = "low" | "medium" | "high" | "auto";

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
  /** Authenticated caller used for policy and usage attribution. */
  principal?: Principal;
  /** Full request ID for cross-referencing logs and durable Fusion runs. */
  requestId?: string;
  /** Stable conversation/session ID, preferably derived from x-opencode-session. */
  conversationId?: string;
  /** Stable client turn ID, preferably derived from x-opencode-request. */
  turnId?: string;
  /** Durable Fusion pipeline run ID for this request. */
  fusionRunId?: string;
  /** Stable fingerprint for the normalized incoming message context. */
  inputFingerprint?: string;
  /** F0-F3 effort selected by the deterministic resolver. */
  resolvedFusionEffort?: FusionEffortLevel;
  /** Compatibility runtime effort used by the current router pipeline. */
  runtimeEffort?: EffortLevel;
  /** Headers that should be propagated to internal upstream calls. */
  extraHeaders?: Record<string, string>;
  /** Bounded execution metadata for nested Fusion/scheduler decisions. */
  execution?: FusionExecutionContext;
  /**
   * Bound observability emitter captured by the router while the request's
   * AsyncLocalStorage context is live. Used via `emitFusion()` so pipeline
   * layers can report progress even from generator/stream boundaries.
   */
  obsEmit?: (event: import("../../observability/event-sink.ts").RequestEvent) => void;
  /**
   * Compact fusion trace assembled by the streaming pipeline, read by the
   * route handler after the stream ends to attach to `request.finished`.
   */
  streamFusionTrace?: Record<string, unknown>;
  /**
   * True if the original request contained image content (image_url parts).
   * Set by the image preprocessor (or upstream) before images are stripped,
   * so downstream scoring and routing can still account for the vision work.
   */
  hadImages?: boolean;
  /** Descriptions produced by the vision model (kimi-k2.7-code) for any images in the request. */
  imageDescriptions?: string[];
}

export interface FusionExecutionContext {
  depth: number;
  maxDepth: number;
  remainingLeafCalls: number;
  remainingTokens: number;
  remainingMs: number;
  parentRunId?: string;
  allowNestedFusion: boolean;
}

// ── Sub-task / Subagent Types ─────────────────────────────────────────

/**
 * A divided sub-task produced by the TaskDividerAgent.
 */
export interface SubTask {
  id: string;
  description: string;
  focus_area: string;
  /** The existing model routing to use for this sub-task (e.g. "glm-5.2"). */
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
  /** Durable subagent run ID if this output was executed or recollected under a Fusion run. */
  subagentRunId?: string;
  /** The raw response content from the subagent. */
  content: string;
  /** Any tool calls made by the subagent. */
  toolCalls?: unknown[];
  /** Error message if failed. */
  error?: string;
  durationMs: number;
  /** Declared context window used when packing this subagent request. */
  contextWindow?: number;
  /** Input budget allocated to conversation/context briefing. */
  inputBudgetTokens?: number;
  /** Output budget reserved for this subagent's response. */
  outputBudgetTokens?: number;
  /** Number of original conversation messages supplied verbatim in the packed request. */
  contextMessageCount?: number;
  /** Number of original conversation messages omitted by adaptive packing. */
  droppedMessageCount?: number;
  /** Estimated tokens for the packed verbatim context messages. */
  packedContextTokens?: number;
}

// ── Complexity Score Result ──────────────────────────────────────────

export interface ComplexityScore {
  score: number; // 0-1
  effort: EffortLevel;
  fusionEffort?: FusionEffortLevel;
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

// ── Fusion Trace / Analytics ──────────────────────────────────────────

/**
 * A single step in the fusion pipeline trace.
 */
export interface FusionStep {
  /** Step type identifier. */
  type: "complexity_scoring" | "task_division" | "subagent_execution" | "synthesis" | "effort_1_fast_path" | "image_preprocessing" | "cache_lookup";
  /** The step label for display. */
  label: string;
  /** When this step started (ISO timestamp). */
  startedAt: string;
  /** How long this step took in milliseconds. */
  durationMs: number;
  /** The model routing used for this step (if applicable). */
  modelRouting?: string;
  /** Additional metadata for this step. */
  details?: Record<string, unknown>;
}

/**
 * Cost breakdown for a single model call within the fusion pipeline.
 */
export interface FusionCostEntry {
  modelRouting: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  userCostUsd: number;
  typicalCostUsd: number;
}

/**
 * Full analytics trace for a fusion request.
 * Exposed in the response for the admin UI / custom client.
 */
export interface FusionTrace {
  /** The version of the trace format. */
  version: 1;
  /** The effort level that was executed. */
  effort: EffortLevel;
  /** The complexity score that was computed. */
  complexityScore: number;
  /** The complexity reason string. */
  complexityReason: string;
  /** All pipeline steps in order. */
  steps: FusionStep[];
  /** Which sub-tasks were divided and how many. */
  subTaskCount: number;
  /** Bounded sub-task metadata for completed/historical observability views. */
  subTasks?: Array<{
    id: string;
    focus: string;
    model: string;
    description: string;
  }>;
  /** Which subagents executed, with their results. */
  subagentDetails?: Array<{
    id: string;
    focus_area: string;
    success: boolean;
    modelRouting: string;
    durationMs: number;
    outputLength: number;
    contextWindow?: number;
    inputBudgetTokens?: number;
    outputBudgetTokens?: number;
    contextMessageCount?: number;
    droppedMessageCount?: number;
    packedContextTokens?: number;
  }>;
  /** Cost breakdown across all model calls in the pipeline. */
  costs: FusionCostEntry[];
  /** Total cost for the full pipeline. */
  totalCostUsd: number;
  /** Total tokens consumed across the full pipeline. */
  totalTokens: number;
  /** Whether the response was served from cache. */
  cacheHit: boolean;
  /** Stable cache/recollection key used for this run, if any. */
  cacheKey?: string;
  /** Stable conversation/session ID for this Fusion run. */
  conversationId?: string;
  /** Stable turn ID for this Fusion run. */
  turnId?: string;
  /** Durable Fusion run ID for this request. */
  fusionRunId?: string;
  /** F0-F3 effort label after deterministic resolution. */
  fusionEffort?: FusionEffortLevel;
  /** The model that produced the final fused output. */
  fusedByModelRouting: string;
  /** Full request ID for cross-referencing with admin logs. */
  requestId?: string;
}

// ── Fusion Result ─────────────────────────────────────────────────────

/**
 * The final result of a fusion request.
 */
export interface FusionResult {
  /** The final response content (from the fusion synthesis model). null when tool_calls are present. */
  content: string | null;
  /** The wire protocol the response is formatted in. */
  wireProtocol: "openai" | "anthropic";
  /** Provider reasoning field, preserved for non-streaming clients when present. */
  reasoning?: string;
  /** Provider reasoning_content field, preserved for OpenAI-compatible clients when present. */
  reasoningContent?: string;
  /** All subagent results (for cache/storage). */
  subagentResults: SubagentResult[];
  /** Final model that produced the fused response. */
  fusedByModelRouting: string;
  /** Tool calls from the upstream response (passthrough for effort 1, or from fuser). */
  toolCalls?: unknown[];
  /** Finish reason from the upstream response. */
  finishReason?: string;
  /** Usage / token tracking. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Full analytics trace — all pipeline steps, costs, model routings. */
  fusionTrace?: FusionTrace;
  /** Whether subagent work was recollected from Fusion cache. */
  cacheHit?: boolean;
  /** Cache/recollection key used by this Fusion run. */
  cacheKey?: string;
}

// ── Cache Types ───────────────────────────────────────────────────────

export interface FusionCacheEntry {
  /** Cache schema version for future invalidation. */
  schemaVersion?: number;
  /** Hash key identifying the request. */
  key: string;
  /** Stable pre-divider request fingerprint key, if available. */
  requestKey?: string;
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
  /** Stable conversation ID that produced this entry (for prefix reuse). */
  conversationId?: string;
  /** Normalized message list at the time of entry creation (for prefix matching). */
  normalizedMessages?: unknown[];
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
