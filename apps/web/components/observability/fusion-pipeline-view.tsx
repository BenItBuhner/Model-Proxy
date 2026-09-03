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
import type { RequestEvent } from "@model-proxy/contracts/api/events.ts";
import { formatCount, formatDurationMs, formatUsd } from "@/lib/format";
import {
  derivePipelineState,
  isKernelPipeline,
  PHASE_LABEL,
  stateFromTrace,
  type FusionTraceLike,
  type KernelTraceLike,
  type PhaseState,
  type PipelineState,
  type SubagentState,
} from "./fusion-pipeline-state";

export type { FusionTraceLike } from "./fusion-pipeline-state";

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
  const subagentDecision = state.phases.find((phase) => phase.key === "subagent_execution");
  const kernel = isKernelPipeline(state);

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
            {kernel ? <Badge tone="warning">kernel</Badge> : null}
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

        {subagentDecision?.detail !== undefined ? (
          <SubagentDecisionPanel phase={subagentDecision} />
        ) : null}

        {kernel ? <KernelSummaryPanel state={state} trace={trace} /> : null}

        {/* Subagent lanes */}
        {state.subagents.length > 0 ? (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
                {kernel ? "workers" : "subagents"} ({state.subagents.length})
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
  const reason = typeof phase.detail?.["reason"] === "string" ? phase.detail["reason"] : undefined;
  const decision = typeof phase.detail?.["decision"] === "string" ? phase.detail["decision"] : undefined;
  return (
    <div
      className={`flex max-w-full items-center gap-2 rounded-sm bg-ink-900 px-2.5 py-1.5 shadow-edge ${
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
      {decision !== undefined || reason !== undefined ? (
        <span className="hidden max-w-56 truncate font-mono text-[9px] text-bone-300 md:inline">
          {decision !== undefined ? `${decision}${reason !== undefined ? ": " : ""}` : ""}
          {reason}
        </span>
      ) : null}
    </div>
  );
}

function SubagentDecisionPanel({ phase }: { phase: PhaseState }): React.ReactElement | null {
  const detail = phase.detail;
  if (detail === undefined) return null;

  const useSubagents = typeof detail["useSubagents"] === "boolean"
    ? detail["useSubagents"]
    : detail["decision"] === "use"
      ? true
      : detail["decision"] === "skip"
        ? false
        : undefined;
  const reason = typeof detail["reason"] === "string" ? detail["reason"] : undefined;
  const activeWindow = asNumber(detail["activeFusionContextWindow"]);
  const declaredWindow = asNumber(detail["declaredFusionContextWindow"]);
  const contextThreshold = asNumber(detail["largeContextThreshold"]);
  const tokenCount = asNumber(detail["tokenCount"]);
  const messageCount = asNumber(detail["messageCount"]);
  const toolCount = asNumber(detail["toolCount"]);
  const referencedFileCount = asNumber(detail["referencedFileCount"]);
  const largeContext = typeof detail["largeContext"] === "boolean" ? detail["largeContext"] : undefined;
  const manyTools = typeof detail["manyTools"] === "boolean" ? detail["manyTools"] : undefined;
  const toolUseAllowed = typeof detail["toolUseAllowed"] === "boolean" ? detail["toolUseAllowed"] : undefined;
  const hasLargeEditIntent = typeof detail["hasLargeEditIntent"] === "boolean" ? detail["hasLargeEditIntent"] : undefined;
  const contextLoadPercent = asNumber(detail["contextLoadPercent"]);
  const activeTriggers = asStringArray(detail["activeTriggers"]);
  const suppressors = asStringArray(detail["suppressors"]);

  const hasDecisionMetrics =
    useSubagents !== undefined ||
    reason !== undefined ||
    activeWindow !== undefined ||
    declaredWindow !== undefined ||
    contextThreshold !== undefined ||
    tokenCount !== undefined ||
    messageCount !== undefined ||
    toolCount !== undefined ||
    referencedFileCount !== undefined ||
    largeContext !== undefined ||
    manyTools !== undefined ||
    toolUseAllowed !== undefined ||
    hasLargeEditIntent !== undefined ||
    contextLoadPercent !== undefined ||
    activeTriggers.length > 0 ||
    suppressors.length > 0;
  if (!hasDecisionMetrics) return null;

  return (
    <div className="space-y-2 rounded-sm bg-ink-900 px-3 py-2 shadow-edge">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
          subagent decision
        </span>
        {useSubagents !== undefined ? (
          <Badge tone={useSubagents ? "phosphor" : "muted"}>
            {useSubagents ? "used" : "skipped"}
          </Badge>
        ) : null}
        {largeContext === true ? <Badge tone="warning">large context</Badge> : null}
        {manyTools === true ? <Badge tone="warning">many tools</Badge> : null}
        {hasLargeEditIntent === true ? <Badge tone="warning">large edit</Badge> : null}
      </div>
      {reason !== undefined ? (
        <div className="font-mono text-[10px] leading-4 text-bone-500">
          {reason}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-ink-700 pt-2 sm:grid-cols-4">
        {tokenCount !== undefined ? <MiniStat label="tokens" value={formatCount(tokenCount)} /> : null}
        {contextThreshold !== undefined ? <MiniStat label="threshold" value={`${formatCount(contextThreshold)} tok`} /> : null}
        {activeWindow !== undefined ? <MiniStat label="active window" value={`${formatCount(activeWindow)} tok`} /> : null}
        {declaredWindow !== undefined ? <MiniStat label="declared" value={`${formatCount(declaredWindow)} tok`} /> : null}
        {messageCount !== undefined ? <MiniStat label="messages" value={formatCount(messageCount)} /> : null}
        {toolCount !== undefined ? <MiniStat label="tools" value={formatCount(toolCount)} /> : null}
        {toolUseAllowed !== undefined ? <MiniStat label="tool use" value={toolUseAllowed ? "allowed" : "disabled"} /> : null}
        {referencedFileCount !== undefined ? <MiniStat label="files" value={formatCount(referencedFileCount)} /> : null}
        {contextLoadPercent !== undefined ? <MiniStat label="load" value={`${contextLoadPercent}%`} /> : null}
      </div>
      {activeTriggers.length > 0 || suppressors.length > 0 ? (
        <div className="grid gap-2 border-t border-ink-700 pt-2 md:grid-cols-2">
          {activeTriggers.length > 0 ? (
            <DecisionSignalList title="triggers" tone="phosphor" items={activeTriggers} />
          ) : null}
          {suppressors.length > 0 ? (
            <DecisionSignalList title="suppressors" tone="muted" items={suppressors} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Kernel engine summary: what the turn classifier decided, how wide the
 * search went, how much agreement it reached, and how much work was reused.
 * Live values come from phase details; completed values from the trace.
 */
function KernelSummaryPanel({
  state,
  trace,
}: {
  state: PipelineState;
  trace: FusionTraceLike | undefined;
}): React.ReactElement | null {
  const kernelTrace: KernelTraceLike | undefined = trace?.kernel;
  const turnPhase = state.phases.find((phase) => phase.key === "turn_classification");
  const consensusPhase = state.phases.find((phase) => phase.key === "escalation");
  const continuationPhase = state.phases.find((phase) => phase.key === "continuation");

  const turn = kernelTrace?.turn ?? asString(turnPhase?.detail?.["kind"]);
  const turnReason = kernelTrace?.turnReason ?? asString(turnPhase?.detail?.["reason"]);
  const mode = kernelTrace?.mode ?? asString(turnPhase?.detail?.["mode"]);
  const band = kernelTrace?.band ?? asString(turnPhase?.detail?.["band"]);
  const requestedEffort = kernelTrace?.requestedEffort ?? asString(turnPhase?.detail?.["requestedEffort"]);
  const waves = kernelTrace?.waves ?? asNumber(consensusPhase?.detail?.["wave"]);
  const agreement = kernelTrace?.agreement ?? asNumber(consensusPhase?.detail?.["agreement"]);
  const accepted = asNumber(consensusPhase?.detail?.["accepted"]);
  const disputed = asNumber(consensusPhase?.detail?.["disputed"]);
  const workCaches = state.caches.filter((cache) => cache.kind === "work");
  const workItems = kernelTrace?.workItems ?? (workCaches.length > 0 ? workCaches.length : undefined);
  const cachedWork = kernelTrace?.cachedWorkItems ?? (workCaches.length > 0 ? workCaches.filter((c) => c.hit).length : undefined);
  const continuationSteps = kernelTrace?.totalContinuationSteps ?? asNumber(continuationPhase?.detail?.["step"]);
  const executor = kernelTrace?.executorRouting ?? continuationPhase?.modelRouting;
  const repair = kernelTrace?.repair ?? asRecord(continuationPhase?.detail?.["repair"]);
  const checkpoint = kernelTrace?.checkpoint ?? continuationPhase?.detail?.["checkpoint"] === true;
  const ledgerHit = state.caches.find((cache) => cache.kind === "ledger")?.hit;

  if (turn === undefined && mode === undefined && kernelTrace === undefined) return null;

  const modeTone: BadgeTone = mode === "continue" ? "phosphor" : mode === "search" ? "warning" : "muted";

  return (
    <div className="space-y-2 rounded-sm bg-ink-900 px-3 py-2 shadow-edge">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">kernel</span>
        {mode !== undefined ? <Badge tone={modeTone}>{mode}</Badge> : null}
        {turn !== undefined ? <Badge tone="bone">{turn.replace(/_/g, " ")}</Badge> : null}
        {band !== undefined ? <Badge tone="muted">{band}</Badge> : null}
        {requestedEffort !== undefined && requestedEffort !== "auto" ? <Badge tone="muted">effort:{requestedEffort}</Badge> : null}
        {ledgerHit === true ? <Badge tone="phosphor">ledger resumed</Badge> : null}
        {repair !== undefined ? <Badge tone="warning">{repair["exhausted"] === true ? "repair exhausted" : "repair"}</Badge> : null}
        {checkpoint ? <Badge tone="warning">checkpoint</Badge> : null}
      </div>
      {turnReason !== undefined ? (
        <div className="font-mono text-[10px] leading-4 text-bone-500">{turnReason}</div>
      ) : null}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 border-t border-ink-700 pt-2 sm:grid-cols-4">
        {waves !== undefined && waves > 0 ? <MiniStat label="waves" value={`${waves}`} /> : null}
        {agreement !== undefined ? <MiniStat label="agreement" value={agreement.toFixed(2)} /> : null}
        {accepted !== undefined ? <MiniStat label="verified" value={`${accepted}`} /> : null}
        {disputed !== undefined ? <MiniStat label="disputed" value={`${disputed}`} /> : null}
        {workItems !== undefined ? (
          <MiniStat label="work items" value={cachedWork !== undefined ? `${cachedWork}/${workItems} reused` : `${workItems}`} />
        ) : null}
        {continuationSteps !== undefined && continuationSteps > 0 ? <MiniStat label="tool steps" value={`${continuationSteps}`} /> : null}
        {executor !== undefined ? <MiniStat label="executor" value={executor} /> : null}
      </div>
      {agreement !== undefined ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-bone-300">cross-family agreement</span>
            <span className="font-mono text-[10px] text-bone-600">{Math.round(agreement * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-phosphor-500 transition-all duration-700"
              style={{ width: `${Math.round(Math.min(1, Math.max(0, agreement)) * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DecisionSignalList({
  title,
  tone,
  items,
}: {
  title: string;
  tone: BadgeTone;
  items: string[];
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-bone-300">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <Badge key={item} tone={tone}>{item}</Badge>
        ))}
      </div>
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
  const contextWindow = asNumber(agent.detail?.["contextWindow"]);
  const inputBudget = asNumber(agent.detail?.["inputBudgetTokens"]);
  const outputBudget = asNumber(agent.detail?.["outputBudgetTokens"]);
  const contextMessages = asNumber(agent.detail?.["contextMessageCount"]);
  const droppedMessages = asNumber(agent.detail?.["droppedMessageCount"]);
  const packedTokens = asNumber(agent.detail?.["packedContextTokens"]);
  const contextPack = asRecord(agent.detail?.["contextPack"]);
  const logicalWindow = asNumber(contextPack?.["logicalContextWindow"]);
  const routeTokenBudget = asNumber(contextPack?.["tokenBudget"]);
  const totalMessages = asNumber(contextPack?.["totalMessages"]);
  const suppliedMessages = asNumber(contextPack?.["suppliedMessages"]);
  const contextPackDropped = asNumber(contextPack?.["droppedMessages"]);
  const coveragePercent = asNumber(contextPack?.["coveragePercent"]);
  const relevantHits = asNumber(contextPack?.["relevantHitCount"]);
  const selectedRanges = typeof contextPack?.["selectedRanges"] === "string" ? contextPack["selectedRanges"] : undefined;
  const mix = asRecord(contextPack?.["mix"]);
  const mixText = mix !== undefined
    ? `f${asNumber(mix["first"]) ?? 0}/r${asNumber(mix["relevant"]) ?? 0}/a${asNumber(mix["anchors"]) ?? 0}/n${asNumber(mix["recent"]) ?? 0}`
    : undefined;
  const stage = typeof agent.detail?.["stage"] === "string" ? agent.detail["stage"] : undefined;
  const hasContextPackStats =
    contextWindow !== undefined ||
    inputBudget !== undefined ||
    outputBudget !== undefined ||
    contextMessages !== undefined ||
    droppedMessages !== undefined ||
    packedTokens !== undefined ||
    logicalWindow !== undefined ||
    routeTokenBudget !== undefined ||
    totalMessages !== undefined ||
    suppliedMessages !== undefined ||
    contextPackDropped !== undefined ||
    coveragePercent !== undefined ||
    relevantHits !== undefined ||
    selectedRanges !== undefined ||
    mixText !== undefined ||
    stage !== undefined;

  return (
    <div className="rounded-sm bg-ink-900 px-3 py-2 shadow-edge">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge tone={tone} className={isActive && live ? "animate-pulse" : ""}>
            {label}
          </Badge>
          {agent.role !== undefined ? <Badge tone="muted">{agent.role}</Badge> : null}
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
      {hasContextPackStats ? (
        <ContextPackDetail
          stage={stage}
          contextWindow={contextWindow}
          inputBudget={inputBudget}
          outputBudget={outputBudget}
          contextMessages={contextMessages}
          droppedMessages={droppedMessages}
          packedTokens={packedTokens}
          logicalWindow={logicalWindow}
          routeTokenBudget={routeTokenBudget}
          totalMessages={totalMessages}
          suppliedMessages={suppliedMessages}
          contextPackDropped={contextPackDropped}
          coveragePercent={coveragePercent}
          relevantHits={relevantHits}
          selectedRanges={selectedRanges}
          mixText={mixText}
        />
      ) : null}
      {agent.error !== undefined && agent.status === "failed" ? (
        <div className="mt-1 truncate font-mono text-[10px] text-alert-500">{agent.error}</div>
      ) : null}
    </div>
  );
}

function ContextPackDetail({
  stage,
  contextWindow,
  inputBudget,
  outputBudget,
  contextMessages,
  droppedMessages,
  packedTokens,
  logicalWindow,
  routeTokenBudget,
  totalMessages,
  suppliedMessages,
  contextPackDropped,
  coveragePercent,
  relevantHits,
  selectedRanges,
  mixText,
}: {
  stage?: string;
  contextWindow?: number;
  inputBudget?: number;
  outputBudget?: number;
  contextMessages?: number;
  droppedMessages?: number;
  packedTokens?: number;
  logicalWindow?: number;
  routeTokenBudget?: number;
  totalMessages?: number;
  suppliedMessages?: number;
  contextPackDropped?: number;
  coveragePercent?: number;
  relevantHits?: number;
  selectedRanges?: string;
  mixText?: string;
}): React.ReactElement {
  const clampedCoverage = Math.min(100, Math.max(0, coveragePercent ?? 0));
  const supplied = suppliedMessages ?? contextMessages;
  const dropped = contextPackDropped ?? droppedMessages;

  return (
    <div className="mt-2 space-y-2 border-t border-ink-700 pt-2">
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-4">
        {stage !== undefined ? <MiniStat label="stage" value={stage.replace(/_/g, " ")} /> : null}
        {logicalWindow !== undefined ? <MiniStat label="logical" value={`${formatCount(logicalWindow)} tok`} /> : null}
        {contextWindow !== undefined ? <MiniStat label="route window" value={`${formatCount(contextWindow)} tok`} /> : null}
        {routeTokenBudget !== undefined ? <MiniStat label="pack budget" value={`${formatCount(routeTokenBudget)} tok`} /> : null}
        {inputBudget !== undefined ? <MiniStat label="input" value={`${formatCount(inputBudget)} tok`} /> : null}
        {outputBudget !== undefined ? <MiniStat label="output" value={`${formatCount(outputBudget)} tok`} /> : null}
        {packedTokens !== undefined ? <MiniStat label="packed" value={`${formatCount(packedTokens)} tok`} /> : null}
        {relevantHits !== undefined ? <MiniStat label="relevant hits" value={formatCount(relevantHits)} /> : null}
        {totalMessages !== undefined ? <MiniStat label="total msgs" value={formatCount(totalMessages)} /> : null}
        {supplied !== undefined ? <MiniStat label="supplied" value={formatCount(supplied)} /> : null}
        {dropped !== undefined ? <MiniStat label="dropped" value={formatCount(dropped)} /> : null}
        {mixText !== undefined ? <MiniStat label="mix" value={mixText} /> : null}
      </div>
      {coveragePercent !== undefined ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-bone-300">
              context coverage
            </span>
            <span className="font-mono text-[10px] text-bone-600">{coveragePercent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div
              className="h-full rounded-full bg-phosphor-500 transition-all duration-700"
              style={{ width: `${clampedCoverage}%` }}
            />
          </div>
        </div>
      ) : null}
      {selectedRanges !== undefined ? (
        <div className="space-y-0.5">
          <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-bone-300">selected ranges</div>
          <div className="break-words font-mono text-[10px] leading-4 text-bone-600">{selectedRanges}</div>
        </div>
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

function MiniStat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[8px] uppercase tracking-[0.14em] text-bone-300">{label}</div>
      <div className="truncate font-mono text-[10px] text-bone-600">{value}</div>
    </div>
  );
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
