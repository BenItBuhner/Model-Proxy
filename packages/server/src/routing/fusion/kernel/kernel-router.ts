import type { FusionKernelConfig } from "@model-proxy/contracts/schemas/fusion.ts";
import { modelConfigLoader } from "../../../config/model-loader.ts";
import { createLogger } from "../../../observability/logger.ts";
import { calculateCosts, resolvePricing } from "../../../observability/pricing.ts";
import { usageSnapshotFromCounts } from "../../../shared/usage-snapshot.ts";
import { sleep, stableHash } from "../../../shared/utils.ts";
import type { FallbackRouter } from "../../fallback.ts";
import { emitFusion, nowIso } from "../fusion-events.ts";
import {
  AsyncEventQueue,
  ReasoningSummarizer,
  SummaryPump,
  paceReasoningText,
  parseOpenAIDelta,
  splitSseEvents,
  type SummarySegment,
} from "../reasoning-summarizer.ts";
import type { ResponseFuser } from "../response-fuser.ts";
import type {
  ComplexityScore,
  FusionCostEntry,
  FusionRequestContext,
  FusionResult,
  FusionStep,
  SubagentResult,
} from "../types.ts";
import { compileCapsule, type Capsule } from "./capsule.ts";
import { INTENT_OBJECTIVE, deterministicIntent, mergeModelIntent } from "./intent.ts";
import { hashMessages, truncateMiddle } from "./messages.ts";
import { ModelPool, type PoolPick } from "./model-pool.ts";
import {
  decideEscalation,
  effortBandFor,
  escalationStrategyNote,
  parseRequestedKernelEffort,
  widthsFor,
  type RequestedKernelEffort,
} from "./scheduler.ts";
import { SessionLedgerStore, beginTask, newLedger } from "./session-ledger.ts";
import { classifyTurn } from "./turn-classifier.ts";
import type {
  Consensus,
  EffortBand,
  KernelFinding,
  KernelLedger,
  NegativeKind,
  Proposal,
  TurnClassification,
  Verification,
  WaveWidths,
  WorkerRole,
} from "./types.ts";
import { buildConsensus, novelClaimCount, parseProposal, parseVerdict } from "./waves.ts";
import { WorkCache, computeWorkKey, type WorkSpec } from "./work-cache.ts";
import { Semaphore, runWorker } from "./worker.ts";

const log = createLogger("routing.fusion.kernel");

type KernelMode = "fast" | "search" | "continue";

interface Narrator {
  say(text: string): Promise<void>;
  segment?: (segment: SummarySegment) => void;
}

const SILENT_NARRATOR: Narrator = { say: async () => undefined };

interface KernelRun {
  kcfg: FusionKernelConfig;
  ledger: KernelLedger;
  storedHashes: string[];
  hashes: string[];
  classification: TurnClassification;
  mode: KernelMode;
  band: EffortBand;
  requested: RequestedKernelEffort;
  configFingerprint: string;
  steps: FusionStep[];
  costs: FusionCostEntry[];
  notes: SubagentResult[];
  workKeys: string[];
  cachedWork: number;
  totalWork: number;
  waves: number;
  agreement: number | undefined;
  persist: boolean;
  narrator: Narrator;
  semaphore: Semaphore;
  pool: ModelPool;
  startedAt: number;
  executorRouting: string;
  fastRouting: string;
  repair?: { signature: string; attempts: number; exhausted: boolean };
  checkpoint?: boolean;
  /** Wall-clock deadline (performance.now() units) for proposal/verification waves. */
  searchDeadlineAt: number;
  /** Workers cancelled by wave quorum (observability). */
  cancelledWorkers: number;
  truncatedWorkers: number;
}

interface QuorumJob<T> {
  family: string;
  start: (signal: AbortSignal) => Promise<T>;
}

interface CachedProposal {
  content: string;
  durationMs: number;
}

interface CachedVerification {
  content: string;
  durationMs: number;
}

interface CachedIntent {
  content: string;
}

/**
 * Fusion Kernel — the `engine: "kernel"` orchestrator.
 *
 * The kernel owns durable state (ledger, work cache, negative results) and
 * dispatches ephemeral bounded-context workers. Per turn it:
 *   1. classifies the turn deterministically against the ledger;
 *   2. continues an in-progress task with a single executor step for tool
 *      continuations (with bounded repair/checkpoint waves when triggered);
 *   3. runs cross-family proposal → verification → consensus waves for fresh
 *      tasks, escalating only on measured disagreement;
 *   4. synthesizes through the existing ResponseFuser so wire protocols,
 *      tool passthrough and summaries stay identical to the legacy engine.
 */
export class FusionKernel {
  private readonly ledgers = new SessionLedgerStore();
  private readonly work = new WorkCache();
  private readonly pools = new Map<string, ModelPool>();

  constructor(
    private readonly fallbackRouter: FallbackRouter,
    private readonly responseFuser: ResponseFuser,
    private readonly summarizer: ReasoningSummarizer,
  ) {}

  // ── Public API ────────────────────────────────────────────────────

  async route(
    ctx: FusionRequestContext,
    score: ComplexityScore,
    steps: FusionStep[],
    costs: FusionCostEntry[],
  ): Promise<FusionResult> {
    const run = this.prepare(ctx, score, steps, costs, SILENT_NARRATOR);
    let result: FusionResult;
    if (run.mode === "fast") {
      result = await this.fastPath(ctx, run);
    } else {
      if (run.mode === "search") await this.runSearch(ctx, run);
      else await this.runContinuation(ctx, run);
      this.applySynthesisContext(ctx, run);
      result = await this.responseFuser.fuse(ctx, run.notes, run.steps, run.costs);
      this.recordAnswer(run, result.content, result.toolCalls);
    }
    this.finalize(ctx, run);
    result.cacheHit = run.mode === "search" && run.totalWork > 0 && run.cachedWork === run.totalWork;
    result.cacheKey = run.workKeys[0];
    return result;
  }

  async *stream(ctx: FusionRequestContext, score: ComplexityScore): AsyncGenerator<string, void, unknown> {
    const steps: FusionStep[] = [];
    const costs: FusionCostEntry[] = [];
    const out = new AsyncEventQueue<string>();
    const narrator: Narrator = {
      say: async (text: string) => {
        for await (const chunk of paceReasoningText(ctx, `${text.trim()}\n\n`)) out.push(chunk);
      },
    };
    const run = this.prepare(ctx, score, steps, costs, narrator);

    if (run.mode === "fast") {
      yield* this.streamFastPath(ctx, run);
      this.finalize(ctx, run);
      this.setStreamTrace(ctx, run, false);
      return;
    }

    const pump = this.summarizer.isEnabled(ctx)
      ? new SummaryPump(this.summarizer, ctx, {
          onSummary: (label, text) => emitFusion(ctx, { type: "fusion.summary", at: nowIso(), label, text }),
        })
      : undefined;
    if (pump !== undefined) {
      narrator.segment = (segment) => pump.enqueue(segment);
      // Single consumer of the pump: forward every summary chunk, then close
      // the outer queue once the pump has drained (pump.finish() closes it).
      void (async () => {
        for await (const chunk of pump.chunks()) out.push(chunk);
        out.close();
      })();
    }

    const searchPromise = (run.mode === "search" ? this.runSearch(ctx, run) : this.runContinuation(ctx, run))
      .catch((err) => {
        log.error("kernel pre-synthesis phase failed", { mode: run.mode, error: String(err) });
        throw err;
      })
      .finally(() => {
        if (pump !== undefined) pump.finish();
        else out.close();
      });
    // Surface rejections through the awaited promise below, not as unhandled.
    searchPromise.catch(() => undefined);

    for await (const chunk of out) yield chunk;
    await searchPromise;

    this.applySynthesisContext(ctx, run);
    const answer = { content: "", toolNames: [] as string[] };
    for await (const chunk of this.responseFuser.fuseStream(ctx, run.notes)) {
      this.observeAnswerChunk(ctx, chunk, answer);
      yield chunk;
    }
    run.steps.push({
      type: "synthesis",
      label: run.mode === "continue" ? "Continuation Step" : "Response Synthesis",
      startedAt: nowIso(),
      durationMs: 0,
      modelRouting: run.executorRouting,
    });
    this.recordAnswer(run, answer.content, answer.toolNames.length > 0 ? answer.toolNames : undefined);
    this.finalize(ctx, run);
    this.setStreamTrace(ctx, run, run.mode === "search" && run.totalWork > 0 && run.cachedWork === run.totalWork);
  }

  // ── Preparation / classification ──────────────────────────────────

  private prepare(
    ctx: FusionRequestContext,
    score: ComplexityScore,
    steps: FusionStep[],
    costs: FusionCostEntry[],
    narrator: Narrator,
  ): KernelRun {
    const kcfg = ctx.fusionConfig.kernel;
    if (kcfg === undefined) throw new Error("fusion.kernel config missing for engine=kernel");
    const startedAt = performance.now();
    const conversationId = ctx.conversationId ?? `ephemeral_${ctx.inputFingerprint ?? ctx.requestId ?? Date.now()}`;
    const persist = ctx.conversationId !== undefined;
    const loaded = persist ? this.ledgers.load(conversationId) : undefined;
    const ledger = loaded?.ledger ?? newLedger(conversationId, ctx.logicalModel);
    const storedHashes = loaded?.messageHashes ?? [];
    const hashes = hashMessages(ctx.messages);
    const classification = classifyTurn(ctx.messages, loaded?.ledger, storedHashes, {
      maxStepsBeforeReplan: kcfg.continuation.max_steps_before_replan,
      repairOnError: kcfg.continuation.repair_on_error,
    });
    const requested = parseRequestedKernelEffort(ctx.requestData);
    const band = effortBandFor(ctx.resolvedFusionEffort, requested);
    const runtimeEffort = ctx.runtimeEffort ?? score.effort;

    let mode: KernelMode;
    const continuing =
      kcfg.continuation.enabled &&
      ledger.intent !== undefined &&
      (classification.kind === "tool_continuation" || classification.kind === "trivial_ack");
    if (continuing) mode = "continue";
    else if (classification.kind === "replay" && ledger.intent !== undefined) {
      // Exact replay of the last turn (client retry): reproduce it. A deep
      // task replays its search — every work key hits the cache — while a
      // fast task simply re-runs the fast path.
      mode = ledger.lastSearch !== undefined ? "search" : runtimeEffort <= 1 ? "fast" : "search";
    } else if (runtimeEffort <= 1 && classification.kind !== "clarification") mode = "fast";
    else mode = "search";

    emitFusion(ctx, { type: "fusion.cache", at: nowIso(), kind: "ledger", hit: loaded !== undefined, detail: loaded !== undefined ? `ledger for ${conversationId.slice(0, 18)}…; task started at message ${ledger.taskStartIndex}` : undefined });
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "turn_classification",
      status: "completed",
      durationMs: Math.round(performance.now() - startedAt),
      detail: {
        kind: classification.kind,
        reason: classification.reason,
        mode,
        band,
        requestedEffort: requested,
        commonPrefix: classification.commonPrefix,
        deltaCount: classification.deltaCount,
        historyRewritten: classification.historyRewritten,
        replan: classification.replan,
        continuationSteps: ledger.continuationSteps,
      },
    });
    steps.push({
      type: "turn_classification",
      label: "Turn Classification",
      startedAt: nowIso(),
      durationMs: Math.round(performance.now() - startedAt),
      details: { kind: classification.kind, reason: classification.reason, mode, band, replan: classification.replan },
    });

    const configFingerprint = stableHash({ kernel: kcfg, synthesis: ctx.fusionConfig.fusion.model_routing }).slice(0, 16);
    const synthesisRouting = kcfg.synthesis_routing ?? ctx.fusionConfig.fusion.model_routing;
    const fastRouting = ctx.fusionConfig.effort_levels[1].model_routing;
    const deepTask = ledger.lastSearch !== undefined || runtimeEffort >= 2;
    const executorRouting = mode === "continue" && !deepTask ? fastRouting : synthesisRouting;

    return {
      kcfg,
      ledger,
      storedHashes,
      hashes,
      classification,
      mode,
      band,
      requested,
      configFingerprint,
      steps,
      costs,
      notes: [],
      workKeys: [],
      cachedWork: 0,
      totalWork: 0,
      waves: 0,
      agreement: undefined,
      persist,
      narrator,
      semaphore: new Semaphore(kcfg.max_concurrency),
      pool: this.poolFor(kcfg, configFingerprint),
      startedAt,
      executorRouting,
      fastRouting,
      searchDeadlineAt: startedAt + kcfg.search_deadline_seconds[band] * 1000,
      cancelledWorkers: 0,
      truncatedWorkers: 0,
    };
  }

  /** Remaining wall-clock budget for search waves, in ms (0 when exhausted). */
  private remainingSearchMs(run: KernelRun): number {
    return Math.max(0, Math.round(run.searchDeadlineAt - performance.now()));
  }

  /**
   * Run a wave of workers in parallel and settle on quorum: once
   * `wave_quorum` of the jobs (spanning ≥ minFamilies families when the wave
   * has that many) have finished, stragglers get `straggler_grace_seconds`
   * and are then cancelled. Cancelled workers return their partial output when
   * it is substantial (see runWorker), so quorum trades tail latency for at
   * most a truncated proposal — never for silent data loss.
   */
  private async runWithQuorum<T>(run: KernelRun, jobs: QuorumJob<T>[], minFamilies: number): Promise<T[]> {
    const { kcfg } = run;
    if (jobs.length === 0) return [];
    const controllers = jobs.map(() => new AbortController());
    const results: T[] = new Array<T>(jobs.length);
    const pending = new Map<number, Promise<{ index: number; value: T }>>();
    jobs.forEach((job, index) => {
      pending.set(index, job.start(controllers[index]!.signal).then((value) => ({ index, value })));
    });

    const distinctFamilies = new Set(jobs.map((j) => j.family)).size;
    // Round, not ceil: 0.67 × 3 = 2.01 must mean "two of three", not "all three".
    const quorumCount = kcfg.wave_quorum >= 1
      ? jobs.length
      : Math.min(jobs.length, Math.max(1, Math.round(jobs.length * kcfg.wave_quorum)));
    const familyTarget = Math.min(minFamilies, distinctFamilies);
    const settledFamilies = new Set<string>();
    let settledCount = 0;
    let graceTimer: Promise<{ index: -1; value: undefined }> | undefined;

    while (pending.size > 0) {
      const racers: Array<Promise<{ index: number; value: T | undefined }>> = [...pending.values()];
      if (graceTimer !== undefined) racers.push(graceTimer);
      const outcome = await Promise.race(racers);
      if (outcome.index === -1) {
        // Grace expired: cancel stragglers, then collect whatever they salvaged.
        for (const index of pending.keys()) controllers[index]!.abort();
        run.cancelledWorkers += pending.size;
        const rest = await Promise.all(pending.values());
        for (const r of rest) results[r.index] = r.value;
        pending.clear();
        break;
      }
      pending.delete(outcome.index);
      results[outcome.index] = outcome.value as T;
      settledCount += 1;
      settledFamilies.add(jobs[outcome.index]!.family);
      if (graceTimer === undefined && pending.size > 0 && settledCount >= quorumCount && settledFamilies.size >= familyTarget) {
        const graceMs = Math.min(kcfg.straggler_grace_seconds * 1000, this.remainingSearchMs(run));
        graceTimer = sleep(graceMs).then(() => ({ index: -1 as const, value: undefined }));
      }
    }
    return results;
  }

  private poolFor(kcfg: FusionKernelConfig, fingerprint: string): ModelPool {
    const existing = this.pools.get(fingerprint);
    if (existing !== undefined) return existing;
    // Never let a fusion model act as a worker (unbounded recursion).
    const safe = kcfg.families.filter((family) => {
      const routings = [family.routing, ...family.alt_routings];
      const nested = routings.filter((routing) => this.isFusionModel(routing));
      if (nested.length > 0) log.warn("kernel family routes to a fusion model; skipping", { family: family.name, nested });
      return nested.length === 0;
    });
    const pool = new ModelPool(safe.length > 0 ? safe : kcfg.families);
    this.pools.set(fingerprint, pool);
    return pool;
  }

  private isFusionModel(routing: string): boolean {
    try {
      return modelConfigLoader.loadConfig(routing).fusion?.enabled === true;
    } catch {
      return false;
    }
  }

  // ── Fast path ─────────────────────────────────────────────────────

  private async fastPath(ctx: FusionRequestContext, run: KernelRun): Promise<FusionResult> {
    const started = performance.now();
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase: "fast_path", status: "started", modelRouting: run.fastRouting });
    this.beginFreshTaskIfNeeded(ctx, run);
    const response = await this.fallbackRouter.callWithFallback({
      logicalModel: run.fastRouting,
      requestData: ctx.requestData,
      targetProtocol: ctx.clientProtocol,
      signal: ctx.signal,
      principal: ctx.principal,
      extraHeaders: ctx.extraHeaders,
    });
    const extracted = extractChatResponse(response);
    const durationMs = Math.round(performance.now() - started);
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase: "fast_path", status: "completed", durationMs, modelRouting: run.fastRouting });
    run.steps.push({
      type: "effort_1_fast_path",
      label: "Kernel Fast Path",
      startedAt: nowIso(),
      durationMs,
      modelRouting: run.fastRouting,
      details: { usage: extracted.usage, hasToolCalls: (extracted.toolCalls?.length ?? 0) > 0 },
    });
    if (extracted.usage !== undefined) {
      const pricing = resolvePricing({ requestedModel: run.fastRouting });
      const cost = calculateCosts(usageSnapshotFromCounts(extracted.usage), pricing);
      run.costs.push({
        modelRouting: run.fastRouting,
        promptTokens: extracted.usage.promptTokens,
        completionTokens: extracted.usage.completionTokens,
        totalTokens: extracted.usage.totalTokens,
        userCostUsd: cost.userCostUsd,
        typicalCostUsd: cost.typicalCostUsd,
      });
    }
    this.recordAnswer(run, extracted.content, extracted.toolCalls);
    return {
      content: extracted.content,
      reasoning: extracted.reasoning,
      reasoningContent: extracted.reasoningContent,
      toolCalls: extracted.toolCalls,
      finishReason: extracted.finishReason,
      wireProtocol: ctx.clientProtocol,
      subagentResults: [],
      fusedByModelRouting: run.fastRouting,
      usage: extracted.usage,
    };
  }

  private async *streamFastPath(ctx: FusionRequestContext, run: KernelRun): AsyncGenerator<string, void, unknown> {
    const started = performance.now();
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase: "fast_path", status: "started", modelRouting: run.fastRouting });
    this.beginFreshTaskIfNeeded(ctx, run);
    const answer = { content: "", toolNames: [] as string[] };
    const stream = this.fallbackRouter.streamWithFallback({
      logicalModel: run.fastRouting,
      requestData: ctx.requestData,
      targetProtocol: ctx.clientProtocol,
      signal: ctx.signal,
      principal: ctx.principal,
      extraHeaders: ctx.extraHeaders,
    });
    for await (const chunk of stream) {
      this.observeAnswerChunk(ctx, chunk, answer);
      yield chunk;
    }
    const durationMs = Math.round(performance.now() - started);
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase: "fast_path", status: "completed", durationMs, modelRouting: run.fastRouting });
    run.steps.push({ type: "effort_1_fast_path", label: "Kernel Fast Path", startedAt: nowIso(), durationMs, modelRouting: run.fastRouting });
    run.executorRouting = run.fastRouting;
    this.recordAnswer(run, answer.content, answer.toolNames.length > 0 ? answer.toolNames : undefined);
  }

  // ── Search (fresh task) ───────────────────────────────────────────

  private beginFreshTaskIfNeeded(ctx: FusionRequestContext, run: KernelRun): void {
    const c = run.classification;
    if (c.kind === "fresh_task" || run.ledger.intent === undefined) {
      const index = c.lastUserIndex >= 0 ? c.lastUserIndex : Math.max(0, ctx.messages.length - 1);
      const goalText = c.lastUserText.length > 0 ? c.lastUserText : "(no explicit instruction)";
      run.ledger = beginTask(run.ledger, deterministicIntent(goalText, index), index);
      return;
    }
    if (c.kind === "clarification" && run.ledger.intent !== undefined) {
      const amended = `${run.ledger.intent.goal}\nAmendment: ${c.lastUserText}`;
      run.ledger = {
        ...run.ledger,
        intent: {
          ...deterministicIntent(amended, run.ledger.intent.sourceMessageIndex),
          // Keep the amendment's hash as the active goal so a replay of it is a continuation.
          goalHash: c.lastUserHash,
        },
        continuationSteps: 0,
      };
    }
  }

  private async runSearch(ctx: FusionRequestContext, run: KernelRun): Promise<void> {
    const { kcfg } = run;
    this.beginFreshTaskIfNeeded(ctx, run);
    const priorFindings = run.classification.kind === "clarification" ? run.ledger.findings : [];
    const taskStartIndex = run.ledger.taskStartIndex;

    // Intent extraction (fast model, cached by work key) runs in parallel with
    // proposal wave 1 so it never sits on the critical path. Proposers always
    // see the deterministic intent (stable across replays); verifiers and the
    // synthesizer see the merged model intent. Skipped when the ledger already
    // carries a model-extracted intent (replay / rewind).
    const baseIntent = run.ledger.intent!;
    const proposerIntent = deterministicIntent(baseIntent.goal.split("\n(Kernel restatement:")[0]!, baseIntent.sourceMessageIndex);
    const intentPromise =
      kcfg.intent_extraction && baseIntent.extractedBy !== "model"
        ? this.extractIntent(ctx, run).catch((err) => log.warn("intent extraction failed; using deterministic intent", { error: String(err) }))
        : Promise.resolve();
    const widths = widthsFor(kcfg, run.band, run.pool.proposerFamilyCount);
    await run.narrator.say(
      `Kernel: new task (${run.band}). Launching ${widths.proposals} independent reasoners across ${run.pool.familyNames.join(", ")}, then cross-family verification.`,
    );

    // Workers in a search see the ledger WITHOUT this search's own outputs so
    // an exact replay compiles byte-identical capsules and hits the work cache.
    const searchLedger: KernelLedger = {
      ...run.ledger,
      findings: priorFindings,
      plan: [],
      disagreements: [],
      lastAnswerSummary: undefined,
      continuationSteps: 0,
      totalContinuationSteps: 0,
      lastSearch: undefined,
    };

    const proposals: Proposal[] = [];
    const verifications: Verification[] = [];
    let consensus: Consensus | undefined;
    let strategyNote: string | undefined;
    let previousAccepted: string[] = [];

    for (let wave = 1; wave <= widths.maxWaves; wave++) {
      run.waves = wave;
      const waveProposals = await this.proposalWave(ctx, run, proposerIntent, searchLedger, wave, widths, taskStartIndex, strategyNote);
      proposals.push(...waveProposals);
      await intentPromise;
      const intent = run.ledger.intent ?? baseIntent;
      if (widths.verifiersPerCandidate > 0 && this.remainingSearchMs(run) > 10_000) {
        const waveVerifications = await this.verificationWave(ctx, run, intent, searchLedger, waveProposals, wave, widths, taskStartIndex);
        verifications.push(...waveVerifications);
      }
      consensus = buildConsensus(proposals, verifications);
      run.agreement = consensus.agreement;
      const acceptedNow = consensus.accepted.map((f) => f.statement);
      const novel = wave === 1 ? acceptedNow.length : novelClaimCount(previousAccepted, acceptedNow);
      previousAccepted = acceptedNow;

      let decision = decideEscalation({
        consensus,
        wave,
        widths,
        agreementThreshold: kcfg.agreement_threshold,
        novelClaimsLastWave: novel,
        familyCount: run.pool.proposerFamilyCount,
      });
      if (decision.escalate && this.remainingSearchMs(run) < 30_000) {
        decision = { escalate: false, reason: `search deadline reached (${kcfg.search_deadline_seconds[run.band]}s); settling with agreement ${consensus.agreement}` };
      }
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "escalation",
        status: "completed",
        detail: {
          wave,
          agreement: consensus.agreement,
          claimConsensus: consensus.claimConsensus,
          verifierAcceptRate: consensus.verifierAcceptRate,
          accepted: consensus.accepted.length,
          disputed: consensus.disputed.length,
          rejected: consensus.rejected.length,
          novelClaims: novel,
          escalate: decision.escalate,
          reason: decision.reason,
        },
      });
      run.steps.push({
        type: "escalation",
        label: decision.escalate ? `Escalation Decision (wave ${wave} → ${wave + 1})` : `Search Settled (wave ${wave})`,
        startedAt: nowIso(),
        durationMs: 0,
        details: { agreement: consensus.agreement, reason: decision.reason, accepted: consensus.accepted.length, disputed: consensus.disputed.length },
      });
      if (!decision.escalate) {
        await run.narrator.say(
          `Kernel: agreement ${consensus.agreement.toFixed(2)} after wave ${wave} (${consensus.accepted.length} verified findings, ${consensus.disputed.length} disputed). Synthesizing.`,
        );
        break;
      }
      await run.narrator.say(`Kernel: ${decision.reason}. Escalating to wave ${wave + 1} with a different strategy.`);
      strategyNote = escalationStrategyNote(consensus, wave + 1);
    }

    await intentPromise;
    const finalConsensus = consensus ?? buildConsensus(proposals, verifications);
    this.applyConsensusToLedger(run, finalConsensus, priorFindings);
    run.ledger.lastSearch = {
      at: nowIso(),
      effort: run.band,
      waves: run.waves,
      agreement: finalConsensus.agreement,
      proposals: proposals.length,
      verifications: verifications.length,
      workKeys: run.workKeys.slice(0, 64),
      cachedWork: run.cachedWork,
      kind: "search",
    };
    run.notes = this.buildSearchNotes(finalConsensus, proposals, verifications);
    ctx.kernelBrief = this.searchBrief(run, finalConsensus, proposals.length, verifications.length);
  }

  private async extractIntent(ctx: FusionRequestContext, run: KernelRun): Promise<void> {
    const { kcfg } = run;
    const base = run.ledger.intent!;
    const started = performance.now();
    const routing = kcfg.fast_routing ?? ctx.fusionConfig.summarizer.model_routing;
    const capsule = compileCapsule({
      messages: ctx.messages,
      intent: base,
      ledger: undefined,
      role: "intent",
      objective: INTENT_OBJECTIVE,
      tokenBudget: Math.min(kcfg.capsule_tokens, 12_000),
      taskStartIndex: run.ledger.taskStartIndex,
    });
    const spec: WorkSpec = {
      kind: "intent",
      objective: INTENT_OBJECTIVE,
      readSetHash: capsule.readSetHash,
      modelRouting: routing,
      strategy: "intent:v1",
      policyVersion: kcfg.policy_version,
      configFingerprint: run.configFingerprint,
    };
    const workKey = computeWorkKey(spec);
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase: "intent", status: "started", modelRouting: routing });
    const cached = this.work.get<CachedIntent>(workKey);
    let raw: string | undefined;
    if (cached !== undefined && cached.status === "completed") {
      raw = cached.result.content;
      this.noteWork(ctx, run, workKey, true, "intent");
    } else {
      const result = await runWorker(ctx, this.fallbackRouter, {
        id: "intent",
        role: "intent",
        focus: "intent extraction",
        routing,
        messages: capsule.messages,
        maxTokens: 1_200,
        timeoutMs: Math.min(45_000, kcfg.worker_timeout_seconds * 1000),
        temperature: 0,
        semaphore: run.semaphore,
        emitEvents: false,
      });
      this.accountWorker(run, routing, capsule, result.content);
      if (result.success) {
        raw = result.content;
        this.work.put(workKey, spec, { content: result.content } satisfies CachedIntent, "completed", run.ledger.conversationId);
      }
      this.noteWork(ctx, run, workKey, false, "intent");
    }
    if (raw !== undefined) run.ledger.intent = mergeModelIntent(base, raw);
    const durationMs = Math.round(performance.now() - started);
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "intent",
      status: "completed",
      durationMs,
      modelRouting: routing,
      detail: { cached: cached !== undefined, extractedBy: run.ledger.intent?.extractedBy, domains: run.ledger.intent?.domains },
    });
    run.steps.push({ type: "intent", label: "Intent Extraction", startedAt: nowIso(), durationMs, modelRouting: routing, details: { cached: cached !== undefined, domains: run.ledger.intent?.domains } });
  }

  private proposerObjective(intent: KernelLedger["intent"], role: WorkerRole): string {
    const goal = truncateMiddle(intent?.goal ?? "", 3_000, "goal trimmed");
    if (role === "repair") {
      return `A tool action taken by the primary agent toward this goal failed (see the most recent tool result). Diagnose the most likely root cause and recommend the single best next action plus one fallback, avoiding the failed strategy.\nGoal: ${goal}`;
    }
    if (role === "checkpoint") {
      return `Review the primary agent's progress toward this goal. State what is done, what remains, what is drifting, and give the precise remaining plan as ordered steps.\nGoal: ${goal}`;
    }
    const deliverables = intent?.deliverables.length ? `\nExpected deliverables: ${intent.deliverables.join("; ")}` : "";
    return `Solve this task as completely and precisely as possible. If it is a question, give the answer with the reasoning that justifies it. If it requires actions in the user's environment, specify the exact actions the primary agent should take, in order, with exact commands/code/edits. Surface risks and what would change your answer.\nGoal: ${goal}${deliverables}`;
  }

  private async proposalWave(
    ctx: FusionRequestContext,
    run: KernelRun,
    intent: NonNullable<KernelLedger["intent"]>,
    ledgerView: KernelLedger,
    wave: number,
    widths: WaveWidths,
    taskStartIndex: number,
    strategyNote: string | undefined,
    role: WorkerRole = "proposer",
    widthOverride?: number,
  ): Promise<Proposal[]> {
    const { kcfg } = run;
    const started = performance.now();
    const picks = run.pool.proposers(widthOverride ?? widths.proposals);
    const objective = this.proposerObjective(intent, role);
    const phase = role === "repair" ? "repair" : role === "checkpoint" ? "checkpoint" : "proposal";
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase, status: "started", detail: { wave, count: picks.length, routings: picks.map((p) => p.routing) } });
    emitFusion(ctx, {
      type: "fusion.subtasks",
      at: nowIso(),
      subTasks: picks.map((pick, i) => ({
        id: `${role}-w${wave}-${i + 1}`,
        focus: `${role} · ${pick.family}`,
        model: pick.routing,
        description: objective.slice(0, 200),
      })),
    });

    const timeoutMs = Math.max(15_000, Math.min(kcfg.worker_timeout_seconds * 1000, this.remainingSearchMs(run)));
    const results = await this.runWithQuorum<Proposal>(
      run,
      picks.map((pick, i) => ({
        family: pick.family,
        start: async (signal): Promise<Proposal> => {
          const id = `${role}-w${wave}-${i + 1}`;
          const capsule = compileCapsule({
            messages: ctx.messages,
            intent,
            ledger: ledgerView,
            role,
            objective,
            tokenBudget: kcfg.capsule_tokens,
            taskStartIndex,
            strategyNote,
          });
          const spec: WorkSpec = {
            kind: role,
            objective,
            readSetHash: capsule.readSetHash,
            modelRouting: pick.routing,
            strategy: `${role}:wave${wave}`,
            policyVersion: kcfg.policy_version,
            configFingerprint: run.configFingerprint,
          };
          const workKey = computeWorkKey(spec);
          const cached = this.work.get<CachedProposal>(workKey);
          if (cached !== undefined && cached.status === "completed") {
            this.noteWork(ctx, run, workKey, true, id, pick, role);
            const parsed = parseProposal(cached.result.content);
            return { id, family: pick.family, routing: pick.routing, wave, ...parsed, raw: cached.result.content, workKey, cached: true, durationMs: 0, success: true };
          }
          const result = await runWorker(ctx, this.fallbackRouter, {
            id,
            role,
            focus: `${role} · ${pick.family}`,
            routing: pick.routing,
            messages: capsule.messages,
            maxTokens: kcfg.worker_max_tokens,
            timeoutMs,
            onSegment: run.narrator.segment,
            semaphore: run.semaphore,
            signal,
          });
          run.pool.recordOutcome(pick.routing, result.success, result.durationMs);
          this.accountWorker(run, pick.routing, capsule, result.content);
          this.noteWork(ctx, run, workKey, false, id, pick, role);
          if (result.truncated === true) run.truncatedWorkers += 1;
          if (!result.success) {
            return { id, family: pick.family, routing: pick.routing, wave, answer: "", claims: [], assumptions: [], risks: [], confidence: undefined, raw: "", workKey, cached: false, durationMs: result.durationMs, success: false, error: result.error };
          }
          // Truncated output is usable evidence for this turn but is not
          // cached: a replay should get the chance to finish it.
          if (result.truncated !== true) {
            this.work.put(workKey, spec, { content: result.content, durationMs: result.durationMs } satisfies CachedProposal, "completed", run.ledger.conversationId);
          }
          const parsed = parseProposal(result.content);
          return { id, family: pick.family, routing: pick.routing, wave, ...parsed, raw: result.content, workKey, cached: false, durationMs: result.durationMs, success: true };
        },
      })),
      Math.min(2, run.pool.proposerFamilyCount),
    );

    const durationMs = Math.round(performance.now() - started);
    const succeeded = results.filter((r) => r.success).length;
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase, status: "completed", durationMs, detail: { wave, total: results.length, succeeded, cached: results.filter((r) => r.cached).length, cancelled: run.cancelledWorkers, truncated: run.truncatedWorkers } });
    run.steps.push({
      type: phase,
      label: role === "proposer" ? `Proposal Wave ${wave}` : role === "repair" ? "Repair Wave" : "Checkpoint Wave",
      startedAt: nowIso(),
      durationMs,
      details: {
        wave,
        total: results.length,
        succeeded,
        cached: results.filter((r) => r.cached).length,
        workers: results.map((r) => ({ id: r.id, family: r.family, model: r.routing, success: r.success, cached: r.cached, durationMs: r.durationMs, claims: r.claims.length, confidence: r.confidence })),
      },
    });
    return results;
  }

  private async verificationWave(
    ctx: FusionRequestContext,
    run: KernelRun,
    intent: NonNullable<KernelLedger["intent"]>,
    ledgerView: KernelLedger,
    proposals: Proposal[],
    wave: number,
    widths: WaveWidths,
    taskStartIndex: number,
  ): Promise<Verification[]> {
    const { kcfg } = run;
    const candidates = proposals.filter((p) => p.success && (p.answer.length > 0 || p.claims.length > 0));
    if (candidates.length === 0) return [];
    const started = performance.now();
    const jobs: Array<{ candidate: Proposal; pick: PoolPick; id: string }> = [];
    for (const candidate of candidates) {
      const picks = run.pool.verifiersFor(candidate.family, widths.verifiersPerCandidate);
      picks.forEach((pick, i) => jobs.push({ candidate, pick, id: `verify-w${wave}-${candidate.id.replace(/^[a-z]+-w\d+-/, "")}-${i + 1}` }));
    }
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase: "verification", status: "started", detail: { wave, count: jobs.length, candidates: candidates.length } });
    await run.narrator.say(`Kernel: verifying ${candidates.length} candidate answer(s) with ${jobs.length} cross-family auditor(s).`);

    const timeoutMs = Math.max(15_000, Math.min(kcfg.worker_timeout_seconds * 1000, this.remainingSearchMs(run)));
    const results = await this.runWithQuorum<Verification>(
      run,
      jobs.map(({ candidate, pick, id }) => ({
        family: pick.family,
        start: async (signal): Promise<Verification> => {
          const objective = `Audit candidate ${candidate.id} (produced by another model family) against the goal. Try hard to falsify it: check every key claim, the arithmetic/logic, the completeness against the deliverables, and the safety of any recommended actions.`;
          const capsule = compileCapsule({
            messages: ctx.messages,
            intent,
            ledger: ledgerView,
            role: "verifier",
            objective,
            tokenBudget: kcfg.capsule_tokens,
            taskStartIndex,
            attachments: [
              { title: `Candidate ${candidate.id} answer`, text: truncateMiddle(candidate.answer, 16_000, "candidate trimmed") },
              { title: "Candidate key claims", text: candidate.claims.map((c, i) => `${i + 1}. ${c}`).join("\n") || "(none extracted)" },
            ],
          });
          const spec: WorkSpec = {
            kind: "verifier",
            objective: `${objective}|${candidate.workKey}`,
            readSetHash: capsule.readSetHash,
            modelRouting: pick.routing,
            strategy: `verify:wave${wave}`,
            policyVersion: kcfg.policy_version,
            configFingerprint: run.configFingerprint,
          };
          const workKey = computeWorkKey(spec);
          const cached = this.work.get<CachedVerification>(workKey);
          if (cached !== undefined && cached.status === "completed") {
            this.noteWork(ctx, run, workKey, true, id, pick, "verifier");
            const parsed = parseVerdict(cached.result.content);
            return { id, proposalId: candidate.id, family: pick.family, routing: pick.routing, ...parsed, raw: cached.result.content, workKey, cached: true, durationMs: 0, success: true };
          }
          const result = await runWorker(ctx, this.fallbackRouter, {
            id,
            role: "verifier",
            focus: `verifier · ${pick.family} → ${candidate.family}`,
            routing: pick.routing,
            messages: capsule.messages,
            maxTokens: Math.min(kcfg.worker_max_tokens, 4_000),
            timeoutMs,
            onSegment: run.narrator.segment,
            semaphore: run.semaphore,
            temperature: 0.2,
            signal,
          });
          run.pool.recordOutcome(pick.routing, result.success, result.durationMs);
          this.accountWorker(run, pick.routing, capsule, result.content);
          this.noteWork(ctx, run, workKey, false, id, pick, "verifier");
          if (result.truncated === true) run.truncatedWorkers += 1;
          if (!result.success) {
            return { id, proposalId: candidate.id, family: pick.family, routing: pick.routing, verdict: "revise", issues: [], correctClaims: [], confidence: undefined, raw: "", workKey, cached: false, durationMs: result.durationMs, success: false, error: result.error };
          }
          if (result.truncated !== true) {
            this.work.put(workKey, spec, { content: result.content, durationMs: result.durationMs } satisfies CachedVerification, "completed", run.ledger.conversationId);
          }
          const parsed = parseVerdict(result.content);
          return { id, proposalId: candidate.id, family: pick.family, routing: pick.routing, ...parsed, raw: result.content, workKey, cached: false, durationMs: result.durationMs, success: true };
        },
      })),
      Math.min(2, run.pool.proposerFamilyCount),
    );

    const durationMs = Math.round(performance.now() - started);
    const verdicts = { accept: 0, revise: 0, reject: 0 };
    for (const v of results) if (v.success) verdicts[v.verdict] += 1;
    emitFusion(ctx, { type: "fusion.phase", at: nowIso(), phase: "verification", status: "completed", durationMs, detail: { wave, total: results.length, ...verdicts, cached: results.filter((r) => r.cached).length, cancelled: run.cancelledWorkers, truncated: run.truncatedWorkers } });
    run.steps.push({
      type: "verification",
      label: `Verification Wave ${wave}`,
      startedAt: nowIso(),
      durationMs,
      details: { wave, total: results.length, ...verdicts, cached: results.filter((r) => r.cached).length, verifiers: results.map((v) => ({ id: v.id, candidate: v.proposalId, family: v.family, model: v.routing, verdict: v.verdict, issues: v.issues.length, success: v.success })) },
    });
    return results;
  }

  private applyConsensusToLedger(run: KernelRun, consensus: Consensus, priorFindings: KernelFinding[]): void {
    const wave = run.waves;
    const toFinding = (f: Consensus["accepted"][number], i: number, prefix: string): KernelFinding => ({
      id: `${prefix}-${wave}-${i + 1}`,
      statement: f.statement,
      status: f.status,
      support: f.support,
      contradictedBy: f.contradictedBy,
      note: f.note,
      wave,
    });
    const findings: KernelFinding[] = [
      ...priorFindings.filter((f) => f.status === "accepted").slice(-20),
      ...consensus.accepted.map((f, i) => toFinding(f, i, "acc")),
      ...consensus.disputed.map((f, i) => toFinding(f, i, "dis")),
      ...consensus.rejected.map((f, i) => toFinding(f, i, "rej")),
    ];
    run.ledger.findings = findings;
    run.ledger.disagreements = [
      ...consensus.disputed.map((f) => `${f.statement}${f.note !== undefined ? ` — ${f.note}` : ""}`),
      ...consensus.openIssues,
    ].slice(0, 30);
    // Plan: deliverables plus imperative accepted findings become pending steps.
    const imperative = /^(add|implement|create|write|run|use|change|update|replace|remove|refactor|fix|install|configure|verify|test|check|compute|apply|set|define|move|rename|migrate)\b/i;
    const steps = [
      ...(run.ledger.intent?.deliverables ?? []),
      ...consensus.accepted.map((f) => f.statement).filter((s) => imperative.test(s)),
    ];
    run.ledger.plan = [...new Set(steps)].slice(0, 24).map((text, i) => ({ id: `step-${i + 1}`, text, status: "pending" as const }));
    for (const rejected of consensus.rejected.slice(0, 10)) {
      this.pushNegative(run, `rej:${stableHash(rejected.statement).slice(0, 16)}`, "rejected_hypothesis", `${rejected.statement}${rejected.note !== undefined ? ` (${rejected.note})` : ""}`);
    }
  }

  private buildSearchNotes(consensus: Consensus, proposals: Proposal[], verifications: Verification[]): SubagentResult[] {
    const notes: SubagentResult[] = [];
    const mk = (id: string, focus: string, description: string, model: string, content: string, durationMs = 0): SubagentResult => ({
      subTask: { id, description, focus_area: focus, suggested_model_routing: model },
      success: true,
      usedModelRouting: model,
      content,
      durationMs,
    });
    if (consensus.accepted.length > 0) {
      notes.push(mk(
        "consensus",
        "VERIFIED CONSENSUS — reliable",
        "Findings independently supported by ≥2 model families or confirmed by a cross-family verifier",
        "kernel",
        consensus.accepted.map((f, i) => `${i + 1}. ${f.statement} [supported by: ${f.support.join(", ")}]`).join("\n"),
      ));
    }
    if (consensus.disputed.length > 0 || consensus.openIssues.length > 0 || consensus.rejected.length > 0) {
      const parts: string[] = [];
      if (consensus.disputed.length > 0) {
        parts.push("DISPUTED (resolve with your own reasoning; state residual uncertainty):");
        parts.push(...consensus.disputed.map((f, i) => `${i + 1}. ${f.statement}${f.note !== undefined ? ` — verifier: ${f.note}` : ""} [asserted by: ${f.support.join(", ")}]`));
      }
      if (consensus.openIssues.length > 0) {
        parts.push("OPEN ISSUES raised by verifiers:");
        parts.push(...consensus.openIssues.map((issue, i) => `${i + 1}. ${issue}`));
      }
      if (consensus.rejected.length > 0) {
        parts.push("REJECTED (refuted — do not use):");
        parts.push(...consensus.rejected.map((f, i) => `${i + 1}. ${f.statement}${f.note !== undefined ? ` — ${f.note}` : ""}`));
      }
      notes.push(mk("disputes", "DISPUTED / OPEN / REJECTED", "Points with verifier objections or refutations", "kernel", parts.join("\n")));
    }
    // Full candidate answers, strongest first (accepted verdicts, then confidence), bounded per note.
    const verdictScore = (p: Proposal): number => {
      const vs = verifications.filter((v) => v.success && v.proposalId === p.id);
      if (vs.length === 0) return 0.5;
      return vs.reduce((s, v) => s + (v.verdict === "accept" ? 1 : v.verdict === "revise" ? 0.5 : 0), 0) / vs.length;
    };
    const ranked = proposals
      .filter((p) => p.success && p.answer.length > 0)
      .sort((a, b) => verdictScore(b) - verdictScore(a) || (b.confidence ?? 0) - (a.confidence ?? 0) || b.wave - a.wave);
    const perNoteChars = Math.max(3_000, Math.floor(60_000 / Math.max(1, ranked.length)));
    for (const p of ranked) {
      const vs = verifications.filter((v) => v.success && v.proposalId === p.id);
      const verdictText = vs.length > 0 ? vs.map((v) => `${v.family}: ${v.verdict}${v.issues.length > 0 ? ` (${v.issues.length} issue(s))` : ""}`).join("; ") : "unverified";
      notes.push(mk(
        p.id,
        `candidate answer · ${p.family} · wave ${p.wave} · verdicts: ${verdictText}`,
        `Independent proposal from ${p.family}${p.confidence !== undefined ? ` (self-confidence ${p.confidence.toFixed(2)})` : ""}`,
        p.routing,
        truncateMiddle(p.answer, perNoteChars, "candidate trimmed"),
        p.durationMs,
      ));
    }
    return notes;
  }

  private searchBrief(run: KernelRun, consensus: Consensus, proposalCount: number, verificationCount: number): string {
    const { kcfg } = run;
    return [
      "KERNEL SYNTHESIS BRIEF",
      `- ${proposalCount} independent reasoner(s) across families [${run.pool.familyNames.join(", ")}] proposed answers over ${run.waves} wave(s); ${verificationCount} cross-family verifier(s) audited them. Agreement ${consensus.agreement.toFixed(2)} (threshold ${kcfg.agreement_threshold}).`,
      "- Notes labelled VERIFIED CONSENSUS are supported by ≥2 model families or confirmed by a verifier: treat them as reliable and build the answer on them.",
      "- Notes labelled DISPUTED need your own judgment; resolve them explicitly and state residual uncertainty where it remains. REJECTED items were refuted: do not use them.",
      "- Candidate answers are full independent attempts ranked by verifier verdicts; merge the best specifics (exact values, code, steps) rather than averaging prose.",
      "- Produce ONE complete, final, user-facing answer for the goal. If the correct next step is an action in the user's environment and tools are available, emit structured tool calls instead of describing them.",
      consensus.agreement < kcfg.agreement_threshold
        ? "- Agreement stayed below threshold: be explicit about what is uncertain and why, and prefer verifiable statements."
        : "",
    ].filter((line) => line.length > 0).join("\n");
  }

  // ── Continuation ──────────────────────────────────────────────────

  private async runContinuation(ctx: FusionRequestContext, run: KernelRun): Promise<void> {
    const { kcfg, classification } = run;
    const intent = run.ledger.intent!;
    const started = performance.now();
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "continuation",
      status: "started",
      modelRouting: run.executorRouting,
      detail: { kind: classification.kind, step: run.ledger.continuationSteps + 1, replan: classification.replan },
    });

    const notes: SubagentResult[] = [];
    const replan = classification.replan;

    if (replan.reasons.includes("tool_error") && replan.errorSignature !== undefined && kcfg.continuation.repair_on_error) {
      const prior = this.work.getNegative(run.ledger.conversationId, replan.errorSignature);
      const attempts = prior?.attempts ?? 0;
      if (attempts < kcfg.continuation.max_repairs_per_signature) {
        const newAttempts = this.work.recordNegative(run.ledger.conversationId, replan.errorSignature, "tool_error", replan.errorExcerpt ?? "tool error");
        this.pushNegative(run, replan.errorSignature, "tool_error", replan.errorExcerpt ?? "tool error", newAttempts);
        run.repair = { signature: replan.errorSignature, attempts: newAttempts, exhausted: false };
        await run.narrator.say(`Kernel: a tool step failed (${truncateMiddle(replan.errorExcerpt ?? "error", 140)}). Running a bounded cross-family repair diagnosis before continuing.`);
        const widths = widthsFor(kcfg, run.band, run.pool.proposerFamilyCount);
        const repairWidth = Math.min(widths.proposals, run.pool.proposerFamilyCount);
        const proposals = await this.proposalWave(ctx, run, intent, run.ledger, run.ledger.lastSearch?.waves ?? 1, widths, run.ledger.taskStartIndex, undefined, "repair", repairWidth);
        const verifications = run.band === "F2"
          ? []
          : await this.verificationWave(ctx, run, intent, run.ledger, proposals, 1, { ...widths, verifiersPerCandidate: 1 }, run.ledger.taskStartIndex);
        const consensus = buildConsensus(proposals, verifications);
        run.agreement = consensus.agreement;
        run.waves = 1;
        for (const f of consensus.accepted.slice(0, 8)) {
          run.ledger.findings.push({ id: `repair-${stableHash(f.statement).slice(0, 8)}`, statement: f.statement, status: "accepted", support: f.support, contradictedBy: [], note: "repair", wave: 0 });
        }
        notes.push(...this.buildSearchNotes(consensus, proposals, verifications).map((n) => ({ ...n, subTask: { ...n.subTask, focus_area: `REPAIR · ${n.subTask.focus_area}` } })));
        run.ledger.lastSearch = { at: nowIso(), effort: run.band, waves: 1, agreement: consensus.agreement, proposals: proposals.length, verifications: verifications.length, workKeys: run.workKeys.slice(0, 32), cachedWork: run.cachedWork, kind: "repair" };
      } else {
        this.work.recordNegative(run.ledger.conversationId, replan.errorSignature, "repair_exhausted", replan.errorExcerpt ?? "tool error");
        this.pushNegative(run, replan.errorSignature, "repair_exhausted", `${replan.errorExcerpt ?? "tool error"} (repeated ${attempts + 1}×)`, attempts + 1);
        run.repair = { signature: replan.errorSignature, attempts: attempts + 1, exhausted: true };
        await run.narrator.say("Kernel: this failure repeated after a repair attempt; forcing a strategy change instead of another repair wave.");
      }
    }

    if (replan.reasons.includes("step_budget") && run.ledger.lastSearch !== undefined) {
      run.checkpoint = true;
      await run.narrator.say(`Kernel: ${run.ledger.continuationSteps} steps since the last plan review; running a bounded checkpoint across families.`);
      const widths = widthsFor(kcfg, run.band, run.pool.proposerFamilyCount);
      const proposals = await this.proposalWave(ctx, run, intent, run.ledger, (run.ledger.lastSearch?.waves ?? 0) + 1, widths, run.ledger.taskStartIndex, undefined, "checkpoint", run.pool.proposerFamilyCount);
      const consensus = buildConsensus(proposals, []);
      const remaining = consensus.accepted.concat(consensus.disputed).map((f) => f.statement).slice(0, 20);
      if (remaining.length > 0) {
        run.ledger.plan = remaining.map((text, i) => ({ id: `ckpt-${i + 1}`, text, status: "pending" as const }));
      }
      notes.push(...this.buildSearchNotes(consensus, proposals, []).map((n) => ({ ...n, subTask: { ...n.subTask, focus_area: `CHECKPOINT · ${n.subTask.focus_area}` } })));
      run.ledger.continuationSteps = 0;
      run.ledger.lastSearch = { ...(run.ledger.lastSearch ?? { at: nowIso(), effort: run.band, waves: 0, agreement: 0, proposals: 0, verifications: 0, workKeys: [], cachedWork: 0, kind: "checkpoint" as const }), at: nowIso(), kind: "checkpoint", waves: 1, proposals: proposals.length, agreement: consensus.agreement };
    }

    run.notes = notes;
    ctx.kernelBrief = this.continuationBrief(run);
    run.ledger.continuationSteps += 1;
    run.ledger.totalContinuationSteps += 1;
    const durationMs = Math.round(performance.now() - started);
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "continuation",
      status: "completed",
      durationMs,
      modelRouting: run.executorRouting,
      detail: { repair: run.repair, checkpoint: run.checkpoint === true, notes: notes.length, step: run.ledger.continuationSteps },
    });
    run.steps.push({
      type: "continuation",
      label: "Plan Continuation",
      startedAt: nowIso(),
      durationMs,
      modelRouting: run.executorRouting,
      details: { kind: classification.kind, step: run.ledger.continuationSteps, repair: run.repair, checkpoint: run.checkpoint === true, reusedSearch: run.ledger.lastSearch?.kind },
    });
  }

  private continuationBrief(run: KernelRun): string {
    const ledger = run.ledger;
    const intent = ledger.intent!;
    const lines: string[] = [
      "KERNEL CONTINUATION BRIEF",
      "You are continuing an in-progress task. The deep planning for it already happened; do NOT restart planning, re-explain the task, or re-answer earlier parts. Read the latest tool results in the conversation and take the next correct step: emit the next tool call(s) if an action is needed, or give the final answer if the goal is achieved.",
      `Goal: ${truncateMiddle(intent.goal, 1_500, "goal trimmed")}`,
    ];
    if (intent.constraints.length > 0) lines.push(`Constraints: ${intent.constraints.slice(0, 8).join("; ")}`);
    if (intent.acceptance.length > 0) lines.push(`Done when: ${intent.acceptance.slice(0, 6).join("; ")}`);
    if (ledger.plan.length > 0) lines.push(`Plan: ${ledger.plan.slice(0, 16).map((s, i) => `${i + 1}. ${s.text}`).join(" | ")}`);
    const accepted = ledger.findings.filter((f) => f.status === "accepted").slice(-12);
    if (accepted.length > 0) lines.push(`Verified findings: ${accepted.map((f) => f.statement).join(" | ")}`);
    if (ledger.negatives.length > 0) {
      lines.push(`Do NOT repeat (already failed): ${ledger.negatives.slice(-6).map((n) => n.detail).join(" | ")}`);
    }
    if (run.repair !== undefined) {
      lines.push(run.repair.exhausted
        ? `The most recent tool failure has now repeated ${run.repair.attempts} time(s) with the same signature. Do not retry the same action; choose a materially different approach or report the blocker precisely.`
        : "The most recent tool step failed; the REPAIR notes below contain a cross-family diagnosis and recommended next action. Follow the best-supported recommendation.");
    }
    if (run.checkpoint === true) lines.push("A CHECKPOINT review of remaining work is attached; align the next steps to it.");
    if (ledger.lastAnswerSummary !== undefined) lines.push(`Your previous turn (summary): ${truncateMiddle(ledger.lastAnswerSummary, 800, "trimmed")}`);
    lines.push(`Steps executed so far on this task: ${ledger.totalContinuationSteps}.`);
    return lines.join("\n");
  }

  // ── Shared helpers ────────────────────────────────────────────────

  private applySynthesisContext(ctx: FusionRequestContext, run: KernelRun): void {
    ctx.kernelSynthesisRouting = run.executorRouting;
    if (ctx.kernelBrief === undefined) ctx.kernelBrief = "KERNEL BRIEF\nAnswer the current request from the conversation context.";
  }

  private noteWork(ctx: FusionRequestContext, run: KernelRun, workKey: string, hit: boolean, id: string, pick?: PoolPick, role?: WorkerRole): void {
    run.totalWork += 1;
    if (hit) run.cachedWork += 1;
    run.workKeys.push(workKey);
    emitFusion(ctx, { type: "fusion.cache", at: nowIso(), kind: "work", hit, detail: `${id}${pick !== undefined ? ` ${pick.routing}` : ""} ${workKey.slice(0, 12)}` });
    if (hit && pick !== undefined && role !== undefined) {
      emitFusion(ctx, { type: "fusion.subagent", at: nowIso(), id, focus: `${role} · ${pick.family}`, model: pick.routing, status: "completed", role, durationMs: 0, detail: { stage: "work_cache_reused", workKey } });
    }
  }

  private accountWorker(run: KernelRun, routing: string, capsule: Capsule, content: string): void {
    const promptTokens = capsule.estimatedTokens;
    const completionTokens = Math.ceil(content.length / 4);
    const pricing = resolvePricing({ requestedModel: routing });
    const cost = calculateCosts(usageSnapshotFromCounts({ promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }), pricing);
    run.costs.push({ modelRouting: routing, promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, userCostUsd: cost.userCostUsd, typicalCostUsd: cost.typicalCostUsd });
  }

  private pushNegative(run: KernelRun, signature: string, kind: NegativeKind, detail: string, attempts = 1): void {
    const existing = run.ledger.negatives.findIndex((n) => n.signature === signature);
    const entry = { signature, kind, detail: truncateMiddle(detail, 300, "trimmed"), attempts, at: nowIso() };
    if (existing >= 0) run.ledger.negatives[existing] = { ...entry, attempts: Math.max(attempts, run.ledger.negatives[existing]!.attempts) };
    else run.ledger.negatives.push(entry);
  }

  private recordAnswer(run: KernelRun, content: string | null | undefined, toolCalls: unknown[] | undefined): void {
    const names = (toolCalls ?? []).map((tc) => {
      if (typeof tc === "string") return tc;
      const obj = tc as Record<string, unknown>;
      const fn = obj?.["function"] as Record<string, unknown> | undefined;
      return typeof fn?.["name"] === "string" ? (fn["name"] as string) : typeof obj?.["name"] === "string" ? (obj["name"] as string) : "tool";
    });
    const parts: string[] = [];
    if (content !== null && content !== undefined && content.trim().length > 0) parts.push(truncateMiddle(content.replace(/\s+/g, " ").trim(), 1_600, "trimmed"));
    if (names.length > 0) parts.push(`[issued tool calls: ${names.slice(0, 8).join(", ")}]`);
    if (parts.length > 0) run.ledger.lastAnswerSummary = parts.join(" ");
  }

  /** Tee the outgoing synthesis stream to capture the answer for the ledger (OpenAI or Anthropic SSE). */
  private observeAnswerChunk(ctx: FusionRequestContext, chunk: string, acc: { content: string; toolNames: string[] }): void {
    if (acc.content.length > 8_000) return;
    for (const event of splitSseEvents(chunk)) {
      if (ctx.clientProtocol === "anthropic") {
        const dataLine = event.split("\n").find((line) => line.startsWith("data:"));
        if (dataLine === undefined) continue;
        try {
          const payload = JSON.parse(dataLine.replace(/^data:\s?/, "")) as Record<string, unknown>;
          const delta = payload["delta"] as Record<string, unknown> | undefined;
          if (payload["type"] === "content_block_delta" && delta?.["type"] === "text_delta" && typeof delta["text"] === "string") acc.content += delta["text"];
          const block = payload["content_block"] as Record<string, unknown> | undefined;
          if (payload["type"] === "content_block_start" && block?.["type"] === "tool_use" && typeof block["name"] === "string") acc.toolNames.push(block["name"] as string);
        } catch {
          // ignore non-JSON events
        }
        continue;
      }
      const parsed = parseOpenAIDelta(event);
      if (parsed === null) continue;
      if (parsed.content.length > 0) acc.content += parsed.content;
      for (const delta of parsed.toolCallDeltas) {
        const fn = delta["function"] as Record<string, unknown> | undefined;
        if (typeof fn?.["name"] === "string" && fn["name"].length > 0) acc.toolNames.push(fn["name"] as string);
      }
    }
  }

  private finalize(ctx: FusionRequestContext, run: KernelRun): void {
    if (run.persist) this.ledgers.save(run.ledger, run.hashes, run.kcfg.policy_version);
    ctx.kernelTrace = {
      engine: "kernel",
      turn: run.classification.kind,
      turnReason: run.classification.reason,
      mode: run.mode,
      band: run.band,
      requestedEffort: run.requested,
      waves: run.waves,
      agreement: run.agreement,
      workItems: run.totalWork,
      cachedWorkItems: run.cachedWork,
      cancelledWorkers: run.cancelledWorkers,
      truncatedWorkers: run.truncatedWorkers,
      searchBudgetSeconds: run.kcfg.search_deadline_seconds[run.band],
      continuationSteps: run.ledger.continuationSteps,
      totalContinuationSteps: run.ledger.totalContinuationSteps,
      findings: run.ledger.findings.length,
      negatives: run.ledger.negatives.length,
      executorRouting: run.executorRouting,
      repair: run.repair,
      checkpoint: run.checkpoint === true,
      pool: run.pool.snapshot(),
      totalMs: Math.round(performance.now() - run.startedAt),
    };
  }

  private setStreamTrace(ctx: FusionRequestContext, run: KernelRun, cacheHit: boolean): void {
    const totalTokens = run.costs.reduce((t, c) => t + c.totalTokens, 0);
    const totalCostUsd = run.costs.reduce((t, c) => t + c.userCostUsd, 0);
    ctx.streamFusionTrace = {
      version: 1,
      effort: ctx.runtimeEffort ?? 2,
      complexityScore: 0,
      complexityReason: "",
      steps: run.steps,
      subTaskCount: run.notes.length,
      subTasks: run.notes.map((n) => ({ id: n.subTask.id, focus: n.subTask.focus_area, model: n.usedModelRouting, description: n.subTask.description.slice(0, 200) })),
      summaries: ctx.fusionSummaries,
      subagentDetails: run.notes.map((n) => ({ id: n.subTask.id, focus_area: n.subTask.focus_area, success: n.success, modelRouting: n.usedModelRouting, durationMs: n.durationMs, outputLength: n.content.length })),
      costs: run.costs,
      totalCostUsd,
      totalTokens,
      cacheHit,
      cacheKey: run.workKeys[0],
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      fusionRunId: ctx.fusionRunId,
      fusionEffort: ctx.resolvedFusionEffort,
      fusedByModelRouting: run.executorRouting,
      requestId: ctx.requestId,
      kernel: ctx.kernelTrace,
    };
  }
}

// ── Response extraction (fast path) ────────────────────────────────────

function extractChatResponse(response: Record<string, unknown>): {
  content: string | null;
  reasoning: string | undefined;
  reasoningContent: string | undefined;
  toolCalls: unknown[] | undefined;
  finishReason: string | undefined;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
} {
  const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
  const usageObj = response["usage"] as Record<string, unknown> | undefined;
  const usage = usageObj
    ? {
        promptTokens: Number(usageObj["prompt_tokens"] ?? usageObj["input_tokens"] ?? 0),
        completionTokens: Number(usageObj["completion_tokens"] ?? usageObj["output_tokens"] ?? 0),
        totalTokens: Number(usageObj["total_tokens"] ?? (Number(usageObj["input_tokens"] ?? 0) + Number(usageObj["output_tokens"] ?? 0))),
      }
    : undefined;
  if (!choices || choices.length === 0) {
    // Anthropic-shaped response.
    const blocks = response["content"] as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(blocks)) {
      const text = blocks.filter((b) => b["type"] === "text").map((b) => String(b["text"] ?? "")).join("\n");
      const tools = blocks.filter((b) => b["type"] === "tool_use");
      return {
        content: tools.length > 0 && text.length === 0 ? null : text,
        reasoning: undefined,
        reasoningContent: undefined,
        toolCalls: tools.length > 0 ? tools : undefined,
        finishReason: typeof response["stop_reason"] === "string" ? (response["stop_reason"] as string) : undefined,
        usage,
      };
    }
    return { content: JSON.stringify(response), reasoning: undefined, reasoningContent: undefined, toolCalls: undefined, finishReason: undefined, usage };
  }
  const choice = choices[0]!;
  const message = choice["message"] as Record<string, unknown> | undefined;
  const finishReason = typeof choice["finish_reason"] === "string" ? (choice["finish_reason"] as string) : undefined;
  if (!message) return { content: JSON.stringify(response), reasoning: undefined, reasoningContent: undefined, toolCalls: undefined, finishReason, usage };
  const toolCalls = message["tool_calls"] as unknown[] | undefined;
  return {
    content: toolCalls && toolCalls.length > 0 ? (typeof message["content"] === "string" ? (message["content"] as string) : null) : ((message["content"] as string | null) ?? null),
    reasoning: typeof message["reasoning"] === "string" ? (message["reasoning"] as string) : undefined,
    reasoningContent: typeof message["reasoning_content"] === "string" ? (message["reasoning_content"] as string) : undefined,
    toolCalls,
    finishReason,
    usage,
  };
}
