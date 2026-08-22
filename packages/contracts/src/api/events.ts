/**
 * Per-request structural events emitted by the router and streamed to the
 * admin UI over `/v1/admin/events/:requestId/stream`. Consumed by both the
 * server event sink and the web observability components — this file is the
 * single source of truth for the wire shape.
 */

export type RequestEvent =
  | {
      type: "request.started";
      at: string;
      protocol: "openai" | "anthropic" | "audio" | "responses";
      endpoint: string;
      model: string;
      stream: boolean;
      enforceEnabled: boolean;
    }
  | {
      type: "route.attempted";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      wireProtocol: "openai" | "anthropic" | "audio" | "responses";
      isFallback: boolean;
      keyHint: string;
      apiKeyEnvVar?: string;
      egressProxyEnvVar?: string;
      egressProxyHint?: string;
    }
  | {
      type: "route.succeeded";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      latencyMs: number;
    }
  | {
      type: "route.failed";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      status?: number;
      errorType: string;
      message: string;
      willFallback: boolean;
    }
  | {
      type: "route.skipped";
      at: string;
      provider: string;
      model: string;
      reason: "multimodal_unsupported" | "context_window_exceeded";
      sourceLogicalModel: string;
      isFallback: boolean;
      estimatedPromptTokens?: number;
      contextWindow?: number;
    }
  | {
      type: "route.hedge.started";
      at: string;
      candidates: number;
      maxParallel: number;
      stream: boolean;
    }
  | {
      type: "route.hedge.candidate_started";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      routeIndex: number;
    }
  | {
      type: "route.hedge.candidate_won";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      latencyMs: number;
      cancelledCandidates: number;
      failedCandidates: number;
    }
  | {
      type: "route.hedge.candidate_cancelled";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      reason: "winner_selected" | "client_abort" | "not_started";
    }
  | {
      type: "route.hedge.candidate_failed";
      at: string;
      attempt: number;
      provider: string;
      model: string;
      errorType: string;
      message: string;
    }
  | {
      type: "key.cooldown";
      at: string;
      provider: string;
      model: string;
      action: string;
      cooldownSeconds?: number;
    }
  | {
      type: "proxy.cooldown";
      at: string;
      provider: string;
      model: string;
      egressProxyEnvVar?: string;
      egressProxyHint?: string;
      cooldownSeconds?: number;
    }
  | {
      type: "autofix.applied";
      at: string;
      protocol: "openai" | "anthropic";
      provider: string;
      model: string;
    }
  | {
      type: "enforce.injected";
      at: string;
      guidanceLength: number;
      protocol: "openai" | "anthropic";
    }
  | {
      type: "enforce.attempt";
      at: string;
      attempt: number;
      maxRetries: number;
    }
  | {
      type: "enforce.validated";
      at: string;
      attempt: number;
      kind: "tool_calls" | "termination";
    }
  | {
      type: "enforce.empty_response";
      at: string;
      attempt: number;
      policy: "strict" | "lenient";
    }
  | { type: "enforce.retry"; at: string; attempt: number; reason: string }
  | {
      type: "enforce.stripped";
      at: string;
      contentBecameNull: boolean;
      toolCallsPreserved: boolean;
    }
  | { type: "stream.chunk"; at: string; bytes: number; chunkNumber: number }
  | {
      type: "fusion.pipeline.started";
      at: string;
      effort: number;
      fusionEffort?: string;
      complexityScore: number;
      complexityReason: string;
      logicalModel: string;
      stream: boolean;
    }
  | {
      type: "fusion.phase";
      at: string;
      phase:
        | "image_preprocessing"
        | "complexity_scoring"
        | "task_division"
        | "subagent_execution"
        | "synthesis"
        | "fast_path";
      status: "started" | "completed" | "failed";
      durationMs?: number;
      modelRouting?: string;
      detail?: Record<string, unknown>;
    }
  | {
      type: "fusion.cache";
      at: string;
      kind: "request" | "conversation" | "subtask";
      hit: boolean;
      detail?: string;
    }
  | {
      type: "fusion.subtasks";
      at: string;
      subTasks: Array<{ id: string; focus: string; model: string; description: string }>;
    }
  | {
      type: "fusion.subagent";
      at: string;
      id: string;
      focus: string;
      model: string;
      status: "started" | "progress" | "retrying" | "completed" | "failed";
      attempt?: number;
      chars?: number;
      durationMs?: number;
      error?: string;
      /** Extra structured detail (e.g. research tool executions). */
      detail?: Record<string, unknown>;
    }
  | {
      type: "fusion.summary";
      at: string;
      label: string;
      text: string;
    }
  | {
      type: "fusion.pipeline.completed";
      at: string;
      totalMs: number;
      trace?: Record<string, unknown>;
    }
  | {
      type: "request.finished";
      at: string;
      status: number;
      totalMs: number;
      errorType?: string;
      errorMessage?: string;
      /** Full fusion pipeline trace, emitted on fusion requests for the admin observability page. */
      fusionTrace?: Record<string, unknown>;
    };

export type RequestEventType = RequestEvent["type"];

/** Snapshot of a request's event trace as served by `/v1/admin/events/:requestId`. */
export interface RequestTrace {
  requestId: string;
  startedAt: number;
  finished: boolean;
  events: RequestEvent[];
}
