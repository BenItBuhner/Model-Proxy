"use client";

/**
 * Interactive fusion pipeline visualization.
 *
 * Renders the live state of a fusion request — complexity/effort, phase
 * progression, subagent lanes with streaming progress, and the live reasoning
 * summary feed — from `fusion.*` observability events. The exact same view is
 * retained once the run completes: statuses freeze in their final state and
 * totals (tokens/cost) fill in from the completed trace.
 *
 * For older/completed requests with no in-memory events, the view degrades
 * gracefully by reconstructing phases and subagents from the stored
 * `fusion_trace`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, StatusDot, type BadgeTone } from "@/components/ui/badge";
import { Panel, PanelBody } from "@/components/ui/panel";
import type { RequestEvent } from "@/lib/test-events";
import { formatCount, formatDurationMs, formatUsd } from "./metric-widget";

// ── Derived pipeline state ────────────────────────────────────────────

type PhaseKey =
  | "image_preprocessing"
  | "complexity_scoring"
  | "task_division"
  | "subagent_execution"
  | "synthesis"
  | "fast_path";

const PHASE_LABEL: Record<PhaseKey, string> = {
  image_preprocessing: "images",
  complexity_scoring: "scoring",
  task_division: "task division",
  subagent_execution: "subagents",
  synthesis: "synthesis",
  fast_path: "fast path",
};

interface PhaseState {
  key: PhaseKey;
  status: "running" | "completed" | "failed";
  durationMs?: number;
  modelRouting?: string;
  detail?: Record<string, unknown>;
  at: string;
}

interface SubagentState {
  id: string;
  focus: string;
  model: string;
  status: "started" | "progress" | "retrying" | "completed" | "failed";
  attempt?: number;
  chars?: number;
  durationMs?: number;
  error?: string;
  startedAtMs?: number;
}

interface CacheState {
  kind: "request" | "conversation" | "subtask";
  hit: boolean;
  detail?: string;
}

interface SummaryEntry {
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
  cacheHit?: boolean;
  totalCostUsd?: number;
  totalTokens?: number;
  fusedByModelRouting?: string;
  steps?: Array<{ type: string; label: string; durationMs: number; modelRouting?: string }>;
  subagentDetails?: Array<{
    id: string;
    focus_area: string;
    success: boolean;
    modelRouting: string;
    durationMs: number;
    outputLength: number;
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

interface PipelineState {
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

function derivePipelineState(events: RequestEvent[]): PipelineState {
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
            detail: next.detail ?? prev.detail,
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
function stateFromTrace(trace: FusionTraceLike): PipelineState {
  const phases: PhaseState[] = (trace.steps ?? []).map((step) => ({
    key: normalizeStepType(step.type),
    status: "completed" as const,
    durationMs: step.durationMs,
    modelRouting: step.modelRouting,
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
    caches: trace.cacheHit !== undefined ? [{ kind: "subtask", hit: trace.cacheHit }] : [],
    subTasks: [],
    subagents: (trace.subagentDetails ?? []).map((sa) => ({
      id: sa.id,
      focus: sa.focus_area,
      model: sa.modelRouting,
      status: sa.success ? ("completed" as const) : ("failed" as const),
      chars: sa.outputLength,
      durationMs: sa.durationMs,
    })),
    summaries: [],
    completed: { totalMs: 0, trace },
  };
}

function normalizeStepType(type: string): PhaseKey {
  switch (type) {
    case "image_preprocessing":
    case "complexity_scoring":
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

// ── Component ─────────────────────────────────────────────────────────

export function FusionPipelineView({
  events,
  live,
  fallbackTrace,
}: {
  events: RequestEvent[];
  live: boolean;
  /** Stored fusion_trace used when no fusion events are in memory (older requests). */
  fallbackTrace?: FusionTraceLike;
}): React.ReactElement | null {
  const derived = useMemo(() => derivePipelineState(events), [events]);
  const state = useMemo(() => {
    if (derived.hasFusionEvents) return derived;
    if (fallbackTrace !== undefined) return stateFromTrace(fallbackTrace);
    return derived;
  }, [derived, fallbackTrace]);

  // Ticking clock so running subagent/pipeline timers count up live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);

  const feedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = feedRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [state.summaries.length]);

  if (!state.hasFusionEvents && fallbackTrace === undefined) return null;

  const trace = state.completed?.trace ?? fallbackTrace;
  const isComplete = state.completed !== undefined || !live;
  const succeeded = state.subagents.filter((s) => s.status === "completed").length;
  const failed = state.subagents.filter((s) => s.status === "failed").length;

  return (
    <Panel
      title="fusion pipeline"
      accent
      badge={
        <span className="flex items-center gap-2">
          <StatusDot tone={isComplete ? (failed > 0 ? "warning" : "phosphor") : "warning"} />
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
            {isComplete ? "complete" : "running"}
          </span>
        </span>
      }
      toolbar={
        state.started !== undefined ? (
          <span className="flex items-center gap-2">
            <Badge tone="phosphor">effort {state.started.effort}</Badge>
            {state.started.fusionEffort !== undefined ? (
              <Badge tone="bone">{state.started.fusionEffort}</Badge>
            ) : null}
            {state.started.stream ? <Badge tone="muted">stream</Badge> : null}
          </span>
        ) : undefined
      }
    >
      <PanelBody className="space-y-4">
        {/* Complexity + cache header */}
        {state.started !== undefined ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
                complexity
              </span>
              <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-ink-900">
                <div
                  className="h-full rounded-full bg-phosphor-500 transition-all duration-700"
                  style={{ width: `${Math.round(Math.min(1, Math.max(0, state.started.complexityScore)) * 100)}%` }}
                />
              </div>
              <span className="shrink-0 font-mono text-[11px] text-bone-700">
                {state.started.complexityScore.toFixed(3)}
              </span>
            </div>
            {state.started.complexityReason.length > 0 ? (
              <div className="font-mono text-[10px] leading-4 text-bone-400">
                {state.started.complexityReason.slice(0, 220)}
              </div>
            ) : null}
            {state.caches.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {state.caches.map((cache, i) => (
                  <Badge key={i} tone={cache.hit ? "phosphor" : "muted"}>
                    {cache.kind} cache {cache.hit ? "hit" : "miss"}
                  </Badge>
                ))}
              </div>
            ) : null}
            {state.caches.some((c) => c.hit && c.detail !== undefined) ? (
              <div className="font-mono text-[10px] leading-4 text-phosphor-500/80">
                {state.caches.find((c) => c.hit && c.detail !== undefined)?.detail}
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Phase track */}
        {state.phases.length > 0 ? (
          <div className="flex flex-wrap items-stretch gap-1.5">
            {state.phases.map((phase) => (
              <PhaseChip key={phase.key} phase={phase} live={live} />
            ))}
          </div>
        ) : null}

        {/* Subagent lanes */}
        {state.subagents.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
                subagents ({state.subagents.length})
              </span>
              <span className="font-mono text-[10px] text-bone-400">
                {succeeded} ok{failed > 0 ? ` · ${failed} failed` : ""}
              </span>
            </div>
            <div className="space-y-1.5">
              {state.subagents.map((agent) => (
                <SubagentLane key={agent.id} agent={agent} now={now} live={live} />
              ))}
            </div>
          </div>
        ) : state.subTasks.length > 0 ? (
          <div className="space-y-1.5">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
              sub-tasks planned ({state.subTasks.length})
            </span>
            <div className="space-y-1">
              {state.subTasks.map((task) => (
                <div key={task.id} className="rounded-sm bg-ink-900 px-3 py-1.5">
                  <span className="font-mono text-[10px] text-bone-700">{task.id}</span>
                  <span className="font-mono text-[10px] text-bone-400"> · {task.focus} · {task.model}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Live reasoning summary feed */}
        {state.summaries.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
                reasoning feed
              </span>
              {live && !isComplete ? <StatusDot tone="phosphor" /> : null}
              <span className="font-mono text-[10px] text-bone-400">
                {state.summaries.length} summar{state.summaries.length === 1 ? "y" : "ies"}
              </span>
            </div>
            <div
              ref={feedRef}
              className="max-h-56 space-y-2 overflow-auto rounded-sm bg-ink-900 p-3 shadow-edge"
            >
              {state.summaries.map((entry, i) => (
                <div key={i} className="space-y-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-phosphor-500/90">
                      {entry.label}
                    </span>
                    <span className="font-mono text-[9px] text-bone-300">
                      {entry.at.length > 0 ? new Date(entry.at).toLocaleTimeString() : ""}
                    </span>
                  </div>
                  <p className="font-mono text-[11px] leading-5 text-bone-600">{entry.text}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Totals footer (fills in when complete) */}
        {trace !== undefined ? (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-ink-500 pt-3 sm:grid-cols-4">
            <Stat label="sub-tasks" value={`${trace.subTaskCount ?? state.subagents.length}`} />
            <Stat label="tokens" value={formatCount(trace.totalTokens)} />
            <Stat label="cost" value={trace.totalCostUsd !== undefined ? formatUsd(trace.totalCostUsd) : "-"} />
            <Stat label="fused by" value={trace.fusedByModelRouting ?? "-"} />
          </div>
        ) : null}

        {/* Cost breakdown (complete state) */}
        {trace?.costs !== undefined && trace.costs.length > 0 ? (
          <details>
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
              cost breakdown ({trace.costs.length})
            </summary>
            <div className="mt-2 space-y-1">
              {trace.costs.map((cost, i) => (
                <div key={i} className="flex items-baseline justify-between rounded-sm bg-ink-900 px-3 py-1.5">
                  <span className="font-mono text-[10px] text-bone-700">{cost.modelRouting}</span>
                  <span className="font-mono text-[10px] text-bone-400">
                    {formatCount(cost.totalTokens)} tok · {formatUsd(cost.userCostUsd)}
                  </span>
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </PanelBody>
    </Panel>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────

function PhaseChip({ phase, live }: { phase: PhaseState; live: boolean }): React.ReactElement {
  const tone: BadgeTone =
    phase.status === "completed" ? "phosphor" : phase.status === "failed" ? "danger" : "warning";
  return (
    <div
      className={`flex items-center gap-2 rounded-sm bg-ink-900 px-2.5 py-1.5 shadow-edge ${
        phase.status === "running" && live ? "animate-pulse" : ""
      }`}
    >
      <StatusDot tone={tone} />
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-bone-700">
        {PHASE_LABEL[phase.key]}
      </span>
      {phase.durationMs !== undefined ? (
        <span className="font-mono text-[10px] text-bone-400">{formatDurationMs(phase.durationMs)}</span>
      ) : phase.status === "running" ? (
        <span className="font-mono text-[10px] text-bone-400">…</span>
      ) : null}
      {phase.modelRouting !== undefined ? (
        <span className="hidden font-mono text-[9px] text-bone-300 sm:inline">{phase.modelRouting}</span>
      ) : null}
    </div>
  );
}

function SubagentLane({
  agent,
  now,
  live,
}: {
  agent: SubagentState;
  now: number;
  live: boolean;
}): React.ReactElement {
  const isActive = agent.status === "started" || agent.status === "progress" || agent.status === "retrying";
  const tone: BadgeTone =
    agent.status === "completed"
      ? "phosphor"
      : agent.status === "failed"
        ? "danger"
        : agent.status === "retrying"
          ? "warning"
          : "bone";
  const label =
    agent.status === "completed"
      ? "done"
      : agent.status === "failed"
        ? "failed"
        : agent.status === "retrying"
          ? `retry ${agent.attempt ?? "?"}`
          : agent.status === "progress"
            ? "reasoning"
            : "starting";
  const elapsedMs =
    agent.durationMs ??
    (isActive && live && agent.startedAtMs !== undefined ? Math.max(0, now - agent.startedAtMs) : undefined);

  return (
    <div className="rounded-sm bg-ink-900 px-3 py-2 shadow-edge">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={tone} className={isActive && live ? "animate-pulse" : ""}>
            {label}
          </Badge>
          <span className="truncate font-mono text-[11px] text-bone-700">{agent.id}</span>
          <span className="hidden truncate font-mono text-[10px] text-bone-400 sm:inline">{agent.focus}</span>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {agent.chars !== undefined && agent.chars > 0 ? (
            <span className="font-mono text-[10px] text-bone-400">{formatCount(agent.chars)} chars</span>
          ) : null}
          {elapsedMs !== undefined ? (
            <span className="font-mono text-[10px] text-bone-500">{formatDurationMs(elapsedMs)}</span>
          ) : null}
        </div>
      </div>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="truncate font-mono text-[9px] text-bone-300">{agent.model}</span>
        {isActive && live ? <ActivityBar /> : null}
      </div>
      {agent.error !== undefined && agent.status === "failed" ? (
        <div className="mt-1 truncate font-mono text-[10px] text-alert-500">{agent.error}</div>
      ) : null}
    </div>
  );
}

/** Indeterminate activity shimmer for running subagents. */
function ActivityBar(): React.ReactElement {
  return (
    <div className="h-1 w-24 overflow-hidden rounded-full bg-ink-700">
      <div className="h-full w-1/3 animate-pulse rounded-full bg-phosphor-500/70" />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="space-y-0.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-bone-300">{label}</div>
      <div className="truncate font-mono text-[11px] text-bone-700">{value}</div>
    </div>
  );
}
