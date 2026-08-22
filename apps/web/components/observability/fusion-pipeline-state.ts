import type { RequestEvent } from "@model-proxy/contracts/api/events.ts";

export type PhaseKey =
  | "image_preprocessing"
  | "complexity_scoring"
  | "cache_lookup"
  | "task_division"
  | "subagent_execution"
  | "synthesis"
  | "fast_path";

export const PHASE_LABEL: Record<PhaseKey, string> = {
  image_preprocessing: "images",
  complexity_scoring: "scoring",
  cache_lookup: "cache",
  task_division: "task division",
  subagent_execution: "subagents",
  synthesis: "synthesis",
  fast_path: "fast path",
};

export interface PhaseState {
  key: PhaseKey;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  modelRouting?: string;
  detail?: Record<string, unknown>;
  at: string;
}

export interface SubagentState {
  id: string;
  focus: string;
  model: string;
  status: "started" | "progress" | "retrying" | "completed" | "failed";
  attempt?: number;
  chars?: number;
  durationMs?: number;
  error?: string;
  detail?: Record<string, unknown>;
  startedAtMs?: number;
}

export interface CacheState {
  kind: "request" | "conversation" | "subtask";
  hit: boolean;
  detail?: string;
}

export interface SummaryEntry {
  label: string;
  text: string;
  at: string;
}

export interface FusionTraceLike {
  effort?: number;
  fusionEffort?: string;
  complexityScore?: number;
  complexityReason?: string;
  subTaskCount?: number;
  subTasks?: Array<{ id: string; focus: string; model: string; description: string }>;
  summaries?: SummaryEntry[];
  cacheHit?: boolean;
  cacheKey?: string;
  totalCostUsd?: number;
  totalTokens?: number;
  fusedByModelRouting?: string;
  steps?: Array<{
    type: string;
    label: string;
    durationMs: number;
    modelRouting?: string;
    detail?: Record<string, unknown>;
    details?: Record<string, unknown>;
  }>;
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
    contextPack?: Record<string, unknown>;
    detail?: Record<string, unknown>;
  }>;
  costs?: Array<{
    modelRouting: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    userCostUsd: number;
    typicalCostUsd: number;
  }>;
}

export interface PipelineState {
  hasFusionEvents: boolean;
  started?: {
    effort: number;
    fusionEffort?: string;
    complexityScore: number;
    complexityReason: string;
    logicalModel: string;
    stream: boolean;
  };
  phases: PhaseState[];
  caches: CacheState[];
  subTasks: Array<{ id: string; focus: string; model: string; description: string }>;
  subagents: SubagentState[];
  summaries: SummaryEntry[];
  completed?: { totalMs: number; trace?: FusionTraceLike };
}

export function derivePipelineState(events: RequestEvent[]): PipelineState {
  const state: PipelineState = {
    hasFusionEvents: false,
    phases: [],
    caches: [],
    subTasks: [],
    subagents: [],
    summaries: [],
  };
  const phaseIndex = new Map<PhaseKey, number>();
  const subagentIndex = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case "fusion.pipeline.started": {
        state.hasFusionEvents = true;
        state.started = {
          effort: event.effort,
          fusionEffort: event.fusionEffort,
          complexityScore: event.complexityScore,
          complexityReason: event.complexityReason,
          logicalModel: event.logicalModel,
          stream: event.stream,
        };
        break;
      }
      case "fusion.phase": {
        state.hasFusionEvents = true;
        const existing = phaseIndex.get(event.phase);
        const next: PhaseState = {
          key: event.phase,
          status: event.status === "started" ? "running" : event.status,
          durationMs: event.durationMs,
          modelRouting: event.modelRouting,
          detail: event.detail,
          at: event.at,
        };
        if (existing !== undefined) {
          const prev = state.phases[existing]!;
          state.phases[existing] = {
            ...prev,
            ...next,
            modelRouting: next.modelRouting ?? prev.modelRouting,
            detail: mergeDetail(prev.detail, next.detail),
          };
        } else {
          phaseIndex.set(event.phase, state.phases.length);
          state.phases.push(next);
        }
        break;
      }
      case "fusion.cache": {
        state.hasFusionEvents = true;
        state.caches.push({ kind: event.kind, hit: event.hit, detail: event.detail });
        break;
      }
      case "fusion.subtasks": {
        state.hasFusionEvents = true;
        state.subTasks = event.subTasks;
        break;
      }
      case "fusion.subagent": {
        state.hasFusionEvents = true;
        const existing = subagentIndex.get(event.id);
        if (existing !== undefined) {
          const prev = state.subagents[existing]!;
          state.subagents[existing] = {
            ...prev,
            status: event.status,
            attempt: event.attempt ?? prev.attempt,
            chars: event.chars ?? prev.chars,
            durationMs: event.durationMs ?? prev.durationMs,
            error: event.error ?? (event.status === "completed" ? undefined : prev.error),
            detail: mergeDetail(prev.detail, event.detail),
          };
        } else {
          subagentIndex.set(event.id, state.subagents.length);
          state.subagents.push({
            id: event.id,
            focus: event.focus,
            model: event.model,
            status: event.status,
            attempt: event.attempt,
            chars: event.chars,
            durationMs: event.durationMs,
            error: event.error,
            detail: event.detail,
            startedAtMs: Date.parse(event.at),
          });
        }
        break;
      }
      case "fusion.summary": {
        state.hasFusionEvents = true;
        state.summaries.push({ label: event.label, text: event.text, at: event.at });
        break;
      }
      case "fusion.pipeline.completed": {
        state.hasFusionEvents = true;
        state.completed = { totalMs: event.totalMs, trace: event.trace as FusionTraceLike | undefined };
        break;
      }
      default:
        break;
    }
  }
  return state;
}

/** Reconstruct a minimal pipeline state from a stored fusion trace (no events). */
export function stateFromTrace(trace: FusionTraceLike): PipelineState {
  const phases: PhaseState[] = (trace.steps ?? []).map((step) => ({
    key: normalizeStepType(step.type),
    status: step.label.toLowerCase().includes("failed") ? "failed" : "completed",
    durationMs: step.durationMs,
    modelRouting: step.modelRouting,
    detail: step.details ?? step.detail,
    at: "",
  }));
  return {
    hasFusionEvents: false,
    started:
      trace.complexityScore !== undefined
        ? {
            effort: trace.effort ?? 0,
            fusionEffort: trace.fusionEffort,
            complexityScore: trace.complexityScore,
            complexityReason: trace.complexityReason ?? "",
            logicalModel: trace.fusedByModelRouting ?? "",
            stream: false,
          }
        : undefined,
    phases,
    caches: trace.cacheHit !== undefined
      ? [{ kind: "subtask", hit: trace.cacheHit, detail: trace.cacheKey !== undefined ? `key ${trace.cacheKey}` : undefined }]
      : [],
    subTasks: trace.subTasks ?? [],
    subagents: (trace.subagentDetails ?? []).map((sa) => ({
      id: sa.id,
      focus: sa.focus_area,
      model: sa.modelRouting,
      status: sa.success ? ("completed" as const) : ("failed" as const),
      chars: sa.outputLength,
      durationMs: sa.durationMs,
      detail: {
        ...sa.detail,
        contextWindow: sa.contextWindow,
        inputBudgetTokens: sa.inputBudgetTokens,
        outputBudgetTokens: sa.outputBudgetTokens,
        contextMessageCount: sa.contextMessageCount,
        droppedMessageCount: sa.droppedMessageCount,
        packedContextTokens: sa.packedContextTokens,
        contextPack: sa.contextPack,
      },
    })),
    summaries: trace.summaries ?? [],
    completed: { totalMs: 0, trace },
  };
}

export function normalizeStepType(type: string): PhaseKey {
  switch (type) {
    case "image_preprocessing":
    case "complexity_scoring":
    case "cache_lookup":
    case "task_division":
    case "subagent_execution":
    case "synthesis":
      return type;
    case "effort_1_fast_path":
      return "fast_path";
    default:
      return "complexity_scoring";
  }
}

function mergeDetail(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (prev === undefined) return next;
  if (next === undefined) return prev;
  return { ...prev, ...next };
}
