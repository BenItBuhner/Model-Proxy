import { createLogger } from "../../observability/logger.ts";
import { ComplexityScorer } from "./complexity-scorer.ts";
import { TaskDividerAgent } from "./task-divider.ts";
import { SubagentExecutor } from "./subagent-executor.ts";
import { ResponseFuser } from "./response-fuser.ts";
import { classifyConversationDelta, ReasoningCache } from "./reasoning-cache.ts";
import { ReasoningSummarizer, SummaryPump, paceReasoningText } from "./reasoning-summarizer.ts";
import { resolveFusionEffort } from "./effort-resolver.ts";
import type {
  ComplexityScore,
  FusionCostEntry,
  FusionRequestContext,
  FusionResult,
  FusionStep,
  GoalpostEvent,
  SubagentResult,
} from "./types.ts";
import { FallbackRouter } from "../fallback.ts";
import { ImagePreprocessor } from "./image-preprocessor.ts";
import { captureFusionEmitter, emitFusion, nowIso } from "./fusion-events.ts";
import { resolvePricing, calculateCosts } from "../../observability/pricing.ts";
import { currentRequestId } from "../../observability/request-context.ts";
import { modelConfigLoader } from "../../config/model-loader.ts";
import {
  finishFusionRun,
  finishFusionSubagentRun,
  hashFusionValue,
  makeFusionRunId,
  makeFusionSubagentRunId,
  recordFusionConversationTurn,
  resolveFusionIdentity,
  startFusionRun,
  startFusionSubagentRun,
} from "../../storage/fusion-store.ts";

const log = createLogger("routing.fusion");

interface SubagentNeedDecision {
  useSubagents: boolean;
  reason: string;
  signals: SubagentDecisionSignals;
}

interface SubagentDecisionSignals {
  runtimeEffort: number;
  fusionEffort?: string;
  tokenCount: number;
  messageCount: number;
  toolCount: number;
  toolUseAllowed: boolean;
  declaredFusionContextWindow: number;
  activeFusionContextWindow: number;
  largeContextThreshold: number;
  contextLoadPercent: number;
  largeContext: boolean;
  manyTools: boolean;
  longConversation: boolean;
  hasToolResults: boolean;
  significantToolResults: boolean;
  toolResultReason?: string;
  hasCodeOrFileWork: boolean;
  hasLargeEditIntent: boolean;
  referencedFileCount: number;
  images: boolean;
  activeTriggers: string[];
  suppressors: string[];
}

function usageSnapshotFromCounts(counts: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}) {
  return {
    ...counts,
    promptTokensEstimated: true,
    completionTokensEstimated: true,
    cacheReadTokens: undefined,
    cacheCreationTokens: undefined,
    cachedTokens: undefined,
  };
}

function traceSubTasks(results: SubagentResult[]): Array<{
  id: string;
  focus: string;
  model: string;
  description: string;
}> {
  const seen = new Set<string>();
  const subTasks: Array<{ id: string; focus: string; model: string; description: string }> = [];
  for (const result of results) {
    if (seen.has(result.subTask.id)) continue;
    seen.add(result.subTask.id);
    subTasks.push({
      id: result.subTask.id,
      focus: result.subTask.focus_area,
      model: result.subTask.suggested_model_routing,
      description: result.subTask.description.slice(0, 200),
    });
  }
  return subTasks;
}

// ── FusionRouter ──────────────────────────────────────────────────────

/**
 * Top-level orchestrator for the Model Fusion (Beta) feature.
 *
 * Handles the full 5-layer pipeline:
 *   Layer 0: Image preprocessing
 *   Layer 1: Reasoning cache lookup
 *   Layer 2: Complexity scoring → effort determination
 *   Layer 3: Task division (agentic, tool-calling)
 *   Layer 4: Parallel subagent execution
 *   Layer 5: Response fusion (sequential append + synthesis)
 *
 * Also builds a full FusionTrace for every request, exposing:
 *   - Every pipeline step with timing and model routing
 *   - Cost breakdown per model call
 *   - Subagent execution details
 *   - Cache hit/miss status
 */
export class FusionRouter {
  private readonly fallbackRouter: FallbackRouter;
  private readonly complexityScorer: ComplexityScorer;
  private readonly taskDivider: TaskDividerAgent;
  private readonly subagentExecutor: SubagentExecutor;
  private readonly responseFuser: ResponseFuser;
  private readonly reasoningCache: ReasoningCache;
  private readonly imagePreprocessor: ImagePreprocessor;
  private readonly summarizer: ReasoningSummarizer;

  constructor() {
    this.fallbackRouter = new FallbackRouter();
    this.complexityScorer = new ComplexityScorer();
    this.taskDivider = new TaskDividerAgent();
    this.subagentExecutor = new SubagentExecutor();
    this.summarizer = new ReasoningSummarizer(this.fallbackRouter);
    this.responseFuser = new ResponseFuser(this.summarizer);
    this.reasoningCache = new ReasoningCache();
    this.imagePreprocessor = new ImagePreprocessor();
  }

  // ── Public API ────────────────────────────────────────────────────

  async route(ctx: FusionRequestContext): Promise<FusionResult> {
    const { clientProtocol, logicalModel } = ctx;

    log.info("fusion route start", { logicalModel, clientProtocol });
    this.prepareRuntimeContext(ctx);

    // Build the trace object — every step appends to this
    const steps: FusionStep[] = [];
    const costs: FusionCostEntry[] = [];
    const pipelineStart = performance.now();

    // Layer 0: Preprocess images
    const imgStart = performance.now();
    await this.imagePreprocessor.process(ctx);
    steps.push({
      type: "image_preprocessing",
      label: "Image Preprocessing",
      startedAt: new Date(Date.now() - (performance.now() - imgStart)).toISOString(),
      durationMs: Math.round(performance.now() - imgStart),
      details: { hadImages: ctx.hadImages ?? false, descriptionCount: ctx.imageDescriptions?.length ?? 0 },
    });

    // Layer 2: Score complexity
    const scoreStart = performance.now();
    const score = this.complexityScorer.score(ctx);
    steps.push({
      type: "complexity_scoring",
      label: "Complexity Scoring",
      startedAt: new Date(Date.now() - (performance.now() - scoreStart)).toISOString(),
      durationMs: Math.round(performance.now() - scoreStart),
      details: { score: score.score, reason: score.reason, tokenCount: score.tokenCount },
    });

    const effortDecision = resolveFusionEffort(ctx, score);
    const effectiveEffort = effortDecision.runtimeEffort;
    score.fusionEffort = effortDecision.resolvedEffort;
    ctx.resolvedFusionEffort = effortDecision.resolvedEffort;
    ctx.runtimeEffort = effectiveEffort;
    if (effortDecision.overrideReason !== undefined) {
      log.info("fusion effort escalated", {
        requested: effortDecision.requestedEffort,
        recommended: effortDecision.recommendedEffort,
        resolved: effortDecision.resolvedEffort,
        reason: effortDecision.overrideReason,
      });
    }

    let result: FusionResult;
    this.startRun(ctx, effectiveEffort, score);
    emitFusion(ctx, {
      type: "fusion.pipeline.started",
      at: nowIso(),
      effort: effectiveEffort,
      fusionEffort: effortDecision.resolvedEffort,
      complexityScore: score.score,
      complexityReason: score.reason,
      logicalModel: ctx.logicalModel,
      stream: false,
    });

    try {
      switch (effectiveEffort) {
        case 1: {
          result = await this.handleEffort1(ctx, score, steps, costs);
          break;
        }
        case 2:
        case 3: {
          result = await this.executeFusionPipeline(ctx, score, steps, costs);
          break;
        }
      }
      this.finishRun(ctx, "completed", result);
    } catch (err) {
      this.finishRun(ctx, "failed", undefined, { error: String(err) });
      throw err;
    }

    // Build the final trace
    const totalMs = Math.round(performance.now() - pipelineStart);
    const totalTokens = costs.reduce((t, c) => t + c.totalTokens, 0);
    const totalCostUsd = costs.reduce((t, c) => t + c.userCostUsd, 0);

    result.fusionTrace = {
      version: 1,
      effort: effectiveEffort,
      complexityScore: score.score,
      complexityReason: score.reason,
      steps,
      subTaskCount: result.subagentResults.length > 0
        ? new Set(result.subagentResults.map(r => r.subTask.id)).size
        : 0,
      subTasks: traceSubTasks(result.subagentResults),
      summaries: ctx.fusionSummaries,
      subagentDetails: result.subagentResults.map(r => ({
        id: r.subTask.id,
        focus_area: r.subTask.focus_area,
        success: r.success,
        modelRouting: r.usedModelRouting,
        durationMs: r.durationMs,
        outputLength: r.content.length,
        contextWindow: r.contextWindow,
        inputBudgetTokens: r.inputBudgetTokens,
        outputBudgetTokens: r.outputBudgetTokens,
        contextMessageCount: r.contextMessageCount,
        droppedMessageCount: r.droppedMessageCount,
        packedContextTokens: r.packedContextTokens,
        contextPack: r.contextPack,
      })),
      costs,
      totalCostUsd,
      totalTokens,
      cacheHit: result.cacheHit === true,
      cacheKey: result.cacheKey,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      fusionRunId: ctx.fusionRunId,
      fusionEffort: effortDecision.resolvedEffort,
      fusedByModelRouting: result.fusedByModelRouting,
      requestId: ctx.requestId,
    };

    log.info("fusion trace complete", {
      effort: effectiveEffort,
      steps: steps.length,
      totalMs,
      totalTokens,
      totalCostUsd: totalCostUsd.toFixed(6),
    });

    emitFusion(ctx, {
      type: "fusion.pipeline.completed",
      at: nowIso(),
      totalMs,
      trace: result.fusionTrace as unknown as Record<string, unknown>,
    });

    return result;
  }

  async *stream(ctx: FusionRequestContext): AsyncGenerator<string, void, unknown> {
    const { fusionConfig, requestData, clientProtocol, logicalModel } = ctx;

    log.info("fusion stream start", { logicalModel, clientProtocol });
    this.prepareRuntimeContext(ctx);

    // Layer 0: Preprocess images
    await this.imagePreprocessor.process(ctx);

    // Layer 2: Score complexity
    const score = this.complexityScorer.score(ctx);

    const effortDecision = resolveFusionEffort(ctx, score);
    const effectiveEffort = effortDecision.runtimeEffort;
    score.fusionEffort = effortDecision.resolvedEffort;
    ctx.resolvedFusionEffort = effortDecision.resolvedEffort;
    ctx.runtimeEffort = effectiveEffort;
    this.startRun(ctx, effectiveEffort, score);
    emitFusion(ctx, {
      type: "fusion.pipeline.started",
      at: nowIso(),
      effort: effectiveEffort,
      fusionEffort: effortDecision.resolvedEffort,
      complexityScore: score.score,
      complexityReason: score.reason,
      logicalModel: ctx.logicalModel,
      stream: true,
    });
    const pipelineStart = performance.now();

    try {
      switch (effectiveEffort) {
        case 1: {
          log.info("effort 1: delegating to fallback router (stream)");
          const fastModel = fusionConfig.effort_levels[1].model_routing;
          emitFusion(ctx, {
            type: "fusion.phase",
            at: nowIso(),
            phase: "fast_path",
            status: "started",
            modelRouting: fastModel,
          });
          const streamGen = this.fallbackRouter.streamWithFallback({
            logicalModel: fastModel,
            requestData,
            targetProtocol: clientProtocol,
            signal: ctx.signal,
            principal: ctx.principal,
            extraHeaders: ctx.extraHeaders,
          });
          for await (const chunk of streamGen) {
            yield chunk;
          }
          const fastMs = Math.round(performance.now() - pipelineStart);
          emitFusion(ctx, {
            type: "fusion.phase",
            at: nowIso(),
            phase: "fast_path",
            status: "completed",
            durationMs: fastMs,
            modelRouting: fastModel,
          });
          ctx.streamFusionTrace = {
            version: 1,
            effort: effectiveEffort,
            complexityScore: score.score,
            complexityReason: score.reason,
            steps: [{ type: "effort_1_fast_path", label: "Effort 1 Fast Path", durationMs: fastMs, modelRouting: fastModel }],
            subTaskCount: 0,
            summaries: ctx.fusionSummaries,
            subagentDetails: [],
            costs: [],
            totalCostUsd: 0,
            totalTokens: 0,
            cacheHit: false,
            fusionEffort: effortDecision.resolvedEffort,
            fusedByModelRouting: fastModel,
            requestId: ctx.requestId,
          };
          break;
        }
        case 2:
        case 3: {
          yield* this.executeFusionPipelineStream(ctx, score);
          break;
        }
      }
      this.finishRun(ctx, "completed");
      emitFusion(ctx, {
        type: "fusion.pipeline.completed",
        at: nowIso(),
        totalMs: Math.round(performance.now() - pipelineStart),
        trace: ctx.streamFusionTrace,
      });
    } catch (err) {
      this.finishRun(ctx, "failed", undefined, { error: String(err) });
      throw err;
    }
  }

  // ── Full Fusion Pipeline (non-streaming) ──────────────────────────

  private async executeFusionPipeline(
    ctx: FusionRequestContext,
    score: ComplexityScore,
    steps: FusionStep[],
    costs: FusionCostEntry[],
  ): Promise<FusionResult> {
    const effort = score.effort;
    log.info(`effort ${effort}: executing fusion pipeline`);
    const cacheEnabled = ctx.fusionConfig.cache.enabled;
    const requestCacheKey = cacheEnabled ? this.reasoningCache.computeRequestKey(ctx) : undefined;
    const imageResults = this.makeImageDescriptionResults(ctx);

    if (requestCacheKey !== undefined) {
      const cachedByRequest = this.reasoningCache.getByRequestKey(requestCacheKey);
      steps.push({
        type: "cache_lookup",
        label: "Pre-Divider Cache Lookup",
        startedAt: new Date().toISOString(),
        durationMs: 0,
        details: { requestCacheKey: requestCacheKey.slice(0, 16), hit: !!cachedByRequest },
      });
      emitFusion(ctx, { type: "fusion.cache", at: nowIso(), kind: "request", hit: !!cachedByRequest });
      if (cachedByRequest) {
        log.info("pre-divider cache hit — reusing subagent results", { requestCacheKey });
        this.emitReusedSubagentEvents(ctx, cachedByRequest.subagentResults, "request", cachedByRequest.key);
        const result = await this.responseFuser.fuse(ctx, [...imageResults, ...cachedByRequest.subagentResults], steps, costs);
        result.cacheHit = true;
        result.cacheKey = cachedByRequest.key;
        return result;
      }
    }

    // Conversation-prefix reuse: if only trivial updates (todo writes, acks,
    // small tool results) were appended since the last deep-reasoning run,
    // reuse the cached subagent results instead of respawning.
    if (cacheEnabled) {
      const reuse = this.reasoningCache.findConversationReuse(ctx);
      if (reuse) {
        steps.push({
          type: "cache_lookup",
          label: "Conversation Reuse",
          startedAt: new Date().toISOString(),
          durationMs: 0,
          details: { hit: true, deltaCount: reuse.deltaCount, reason: reuse.reason },
        });
        emitFusion(ctx, {
          type: "fusion.cache",
          at: nowIso(),
          kind: "conversation",
          hit: true,
          detail: `${reuse.deltaCount} trivial delta message(s): ${reuse.reason}`,
        });
        if (requestCacheKey !== undefined) {
          this.reasoningCache.linkRequestKey(requestCacheKey, reuse.entry.key);
        }
        this.emitReusedSubagentEvents(ctx, reuse.entry.subagentResults, "conversation", reuse.entry.key, {
          deltaCount: reuse.deltaCount,
          reason: reuse.reason,
        });
        const result = await this.responseFuser.fuse(ctx, [...imageResults, ...reuse.entry.subagentResults], steps, costs);
        result.cacheHit = true;
        result.cacheKey = reuse.entry.key;
        return result;
      }
    }

    const subagentNeed = this.evaluateSubagentNeed(ctx, score);
    steps.push({
      type: "subagent_execution",
      label: subagentNeed.useSubagents ? "Subagent Decision" : "Subagent Execution Skipped",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      details: {
        useSubagents: subagentNeed.useSubagents,
        reason: subagentNeed.reason,
        ...subagentNeed.signals,
      },
    });
    if (!subagentNeed.useSubagents) {
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "subagent_execution",
        status: "completed",
        detail: {
          decision: "skip",
          reason: subagentNeed.reason,
          ...subagentNeed.signals,
        },
      });
    }
    if (!subagentNeed.useSubagents) {
      log.info("skipping fusion subagents", {
        useSubagents: subagentNeed.useSubagents,
        reason: subagentNeed.reason,
        ...subagentNeed.signals,
      });
      const result = await this.responseFuser.fuse(ctx, imageResults, steps, costs);
      result.cacheHit = false;
      return result;
    }

    // Layer 3: Divide the task
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "task_division",
      status: "started",
      modelRouting: ctx.fusionConfig.task_divider.model_routing,
    });
    const divStart = performance.now();
    const subTasks = await this.taskDivider.divide(ctx);
    steps.push({
      type: "task_division",
      label: "Task Division",
      startedAt: new Date(Date.now() - (performance.now() - divStart)).toISOString(),
      durationMs: Math.round(performance.now() - divStart),
      modelRouting: ctx.fusionConfig.task_divider.model_routing,
      details: {
        subTaskCount: subTasks.length,
        subTasks: subTasks.map(t => ({ id: t.id, focus: t.focus_area, model: t.suggested_model_routing, desc: t.description.slice(0, 100) })),
      },
    });
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "task_division",
      status: "completed",
      durationMs: Math.round(performance.now() - divStart),
      modelRouting: ctx.fusionConfig.task_divider.model_routing,
      detail: { subTaskCount: subTasks.length },
    });
    emitFusion(ctx, {
      type: "fusion.subtasks",
      at: nowIso(),
      subTasks: subTasks.map((t) => ({
        id: t.id,
        focus: t.focus_area,
        model: t.suggested_model_routing,
        description: t.description.slice(0, 200),
      })),
    });

    log.info(`task divided into ${subTasks.length} sub-tasks`);

    // Layer 1: Check reasoning cache
    const cacheKey = cacheEnabled ? this.reasoningCache.computeKey(ctx, subTasks) : undefined;
    const cachedEntry = cacheKey !== undefined ? this.reasoningCache.get(cacheKey) : null;

    steps.push({
      type: "cache_lookup",
      label: "Cache Lookup",
      startedAt: new Date().toISOString(),
      durationMs: 0,
      details: { cacheEnabled, cacheKey: cacheKey?.slice(0, 16), hit: !!cachedEntry },
    });
    if (cacheKey !== undefined) {
      emitFusion(ctx, { type: "fusion.cache", at: nowIso(), kind: "subtask", hit: !!cachedEntry });
    }

    if (cachedEntry) {
      log.info("cache hit — reconstructing subagent results", { key: cacheKey });
      steps[steps.length - 1].details = { ...steps[steps.length - 1].details as Record<string, unknown>, hit: true };
      const base = cachedEntry.subagentResults;
      this.emitReusedSubagentEvents(ctx, base, "subtask", cachedEntry.key);
      const result = await this.responseFuser.fuse(ctx, [...imageResults, ...base], steps, costs);
      result.cacheHit = true;
      result.cacheKey = cachedEntry.key;
      return result;
    }

    // Layer 4: Execute subagents in parallel
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "subagent_execution",
      status: "started",
      detail: { count: subTasks.length },
    });
    const execStart = performance.now();
    const subagentResults = await this.subagentExecutor.execute(ctx, subTasks);
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "subagent_execution",
      status: "completed",
      durationMs: Math.round(performance.now() - execStart),
      detail: {
        total: subagentResults.length,
        succeeded: subagentResults.filter((r) => r.success).length,
      },
    });
    steps.push({
      type: "subagent_execution",
      label: "Subagent Execution",
      startedAt: new Date(Date.now() - (performance.now() - execStart)).toISOString(),
      durationMs: Math.round(performance.now() - execStart),
      details: {
        total: subagentResults.length,
        succeeded: subagentResults.filter(r => r.success).length,
        failed: subagentResults.filter(r => !r.success).length,
        models: [...new Set(subagentResults.map(r => r.usedModelRouting))],
        subagentTimings: subagentResults.map(r => ({
          id: r.subTask.id,
          model: r.usedModelRouting,
          success: r.success,
          durationMs: r.durationMs,
          outputLen: r.content.length,
        })),
      },
    });

    const combined = [...imageResults, ...subagentResults];
    const succeeded = combined.filter(r => r.success).length;
    log.info(`subagent execution complete: ${succeeded}/${combined.length} succeeded`);

    // Collect costs from subagent calls
    for (const r of subagentResults) {
      if (r.success && r.content) {
        const estTokens = Math.ceil(r.content.length / 4);
        const pricing = resolvePricing({ requestedModel: r.usedModelRouting });
        const costs_ = calculateCosts(
          usageSnapshotFromCounts({
            promptTokens: estTokens,
            completionTokens: estTokens,
            totalTokens: estTokens * 2,
          }),
          pricing,
        );
        costs.push({
          modelRouting: r.usedModelRouting,
          promptTokens: estTokens,
          completionTokens: estTokens,
          totalTokens: estTokens * 2,
          userCostUsd: costs_.userCostUsd,
          typicalCostUsd: costs_.typicalCostUsd,
        });
      }
    }

    // Layer 5: Fuse responses
    const fusionResult = await this.responseFuser.fuse(ctx, combined, steps, costs);

    // Store only complete successful subagent sets. A transient failed
    // subagent should get another chance on the next equivalent turn instead
    // of being replayed from cache as degraded reasoning.
    if (cacheKey !== undefined && this.shouldCacheSubagentResults(subagentResults)) {
      this.reasoningCache.set(
        cacheKey,
        subagentResults,
        subTasks,
        score,
        fusionResult.content ?? undefined,
        requestCacheKey,
        { conversationId: ctx.conversationId, messages: ctx.messages },
      );
      fusionResult.cacheKey = cacheKey;
    }
    fusionResult.cacheHit = false;

    return fusionResult;
  }

  // ── Full Fusion Pipeline (streaming) ──────────────────────────────

  private async *executeFusionPipelineStream(
    ctx: FusionRequestContext,
    score: ComplexityScore,
  ): AsyncGenerator<string, void, unknown> {
    const effort = score.effort;
    log.info(`effort ${effort}: executing fusion pipeline (streaming)`);
    const cacheEnabled = ctx.fusionConfig.cache.enabled;
    const requestCacheKey = cacheEnabled ? this.reasoningCache.computeRequestKey(ctx) : undefined;
    const imageResults = this.makeImageDescriptionResults(ctx);
    const streamSteps: Array<Record<string, unknown>> = [];

    const setStreamTrace = (
      results: SubagentResult[],
      cacheHit: boolean,
      cacheKey?: string,
    ): void => {
      const estCosts = results
        .filter((r) => r.success && r.content)
        .map((r) => {
          const estTokens = Math.ceil(r.content.length / 4);
          const pricing = resolvePricing({ requestedModel: r.usedModelRouting });
          const c = calculateCosts(
            usageSnapshotFromCounts({ promptTokens: estTokens, completionTokens: estTokens, totalTokens: estTokens * 2 }),
            pricing,
          );
          return {
            modelRouting: r.usedModelRouting,
            promptTokens: estTokens,
            completionTokens: estTokens,
            totalTokens: estTokens * 2,
            userCostUsd: c.userCostUsd,
            typicalCostUsd: c.typicalCostUsd,
          };
        });
      ctx.streamFusionTrace = {
        version: 1,
        effort: ctx.runtimeEffort ?? effort,
        complexityScore: score.score,
        complexityReason: score.reason,
        steps: streamSteps,
        subTaskCount: new Set(results.map((r) => r.subTask.id)).size,
        subTasks: traceSubTasks(results),
        summaries: ctx.fusionSummaries,
        subagentDetails: results.map((r) => ({
          id: r.subTask.id,
          focus_area: r.subTask.focus_area,
          success: r.success,
          modelRouting: r.usedModelRouting,
          durationMs: r.durationMs,
          outputLength: r.content.length,
          contextWindow: r.contextWindow,
          inputBudgetTokens: r.inputBudgetTokens,
          outputBudgetTokens: r.outputBudgetTokens,
          contextMessageCount: r.contextMessageCount,
          droppedMessageCount: r.droppedMessageCount,
          packedContextTokens: r.packedContextTokens,
          contextPack: r.contextPack,
        })),
        costs: estCosts,
        totalCostUsd: estCosts.reduce((t, c) => t + c.userCostUsd, 0),
        totalTokens: estCosts.reduce((t, c) => t + c.totalTokens, 0),
        cacheHit,
        cacheKey,
        conversationId: ctx.conversationId,
        turnId: ctx.turnId,
        fusionRunId: ctx.fusionRunId,
        fusionEffort: ctx.resolvedFusionEffort,
        fusedByModelRouting: ctx.fusionConfig.fusion.model_routing,
        requestId: ctx.requestId,
      };
    };

    if (requestCacheKey !== undefined) {
      const cachedByRequest = this.reasoningCache.getByRequestKey(requestCacheKey);
      emitFusion(ctx, {
        type: "fusion.cache",
        at: nowIso(),
        kind: "request",
        hit: !!cachedByRequest,
        detail: cachedByRequest ? `reused ${cachedByRequest.subagentResults.length} subagent result(s)` : undefined,
      });
      if (cachedByRequest) {
        log.info("pre-divider stream cache hit — reusing subagent results", { requestCacheKey });
        this.emitReusedSubagentEvents(ctx, cachedByRequest.subagentResults, "request", cachedByRequest.key);
        const combined = [...imageResults, ...cachedByRequest.subagentResults];
        streamSteps.push({ type: "cache_lookup", label: "Pre-Divider Cache Hit", durationMs: 0 });
        yield* paceReasoningText(
          ctx,
          `Recalling ${cachedByRequest.subagentResults.length} prior deep-reasoning result(s) for this turn instead of re-running subagents.\n\n`,
        );
        const synthStart = performance.now();
        yield* this.responseFuser.fuseStream(ctx, combined);
        streamSteps.push({
          type: "synthesis",
          label: "Response Synthesis",
          durationMs: Math.round(performance.now() - synthStart),
          modelRouting: ctx.fusionConfig.fusion.model_routing,
        });
        setStreamTrace(cachedByRequest.subagentResults, true, cachedByRequest.key);
        this.finishRun(ctx, "completed", {
          content: cachedByRequest.fusedContent ?? null,
          wireProtocol: ctx.clientProtocol,
          subagentResults: cachedByRequest.subagentResults,
          fusedByModelRouting: ctx.fusionConfig.fusion.model_routing,
          cacheHit: true,
          cacheKey: cachedByRequest.key,
        });
        return;
      }
    }

    // Conversation-prefix reuse: skip divider + subagents entirely when only
    // trivial updates were appended since the last deep-reasoning run.
    if (cacheEnabled) {
      const reuse = this.reasoningCache.findConversationReuse(ctx);
      if (reuse) {
        emitFusion(ctx, {
          type: "fusion.cache",
          at: nowIso(),
          kind: "conversation",
          hit: true,
          detail: `${reuse.deltaCount} trivial delta message(s): ${reuse.reason}`,
        });
        if (requestCacheKey !== undefined) {
          this.reasoningCache.linkRequestKey(requestCacheKey, reuse.entry.key);
        }
        this.emitReusedSubagentEvents(ctx, reuse.entry.subagentResults, "conversation", reuse.entry.key, {
          deltaCount: reuse.deltaCount,
          reason: reuse.reason,
        });
        const combined = [...imageResults, ...reuse.entry.subagentResults];
        streamSteps.push({ type: "cache_lookup", label: "Conversation Reuse", durationMs: 0 });
        yield* paceReasoningText(
          ctx,
          `Reusing prior deep reasoning from ${reuse.entry.subagentResults.length} subagent(s) — only trivial updates (${reuse.reason}) arrived since.\n\n`,
        );
        const synthStart = performance.now();
        yield* this.responseFuser.fuseStream(ctx, combined);
        streamSteps.push({
          type: "synthesis",
          label: "Response Synthesis",
          durationMs: Math.round(performance.now() - synthStart),
          modelRouting: ctx.fusionConfig.fusion.model_routing,
        });
        setStreamTrace(reuse.entry.subagentResults, true, reuse.entry.key);
        this.finishRun(ctx, "completed", {
          content: reuse.entry.fusedContent ?? null,
          wireProtocol: ctx.clientProtocol,
          subagentResults: reuse.entry.subagentResults,
          fusedByModelRouting: ctx.fusionConfig.fusion.model_routing,
          cacheHit: true,
          cacheKey: reuse.entry.key,
        });
        return;
      }
    }

    const subagentNeed = this.evaluateSubagentNeed(ctx, score);
    streamSteps.push({
      type: "subagent_execution",
      label: subagentNeed.useSubagents ? "Subagent Decision" : "Subagent Execution Skipped",
      durationMs: 0,
      detail: {
        useSubagents: subagentNeed.useSubagents,
        reason: subagentNeed.reason,
        ...subagentNeed.signals,
      },
    });
    if (!subagentNeed.useSubagents) {
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "subagent_execution",
        status: "completed",
        detail: {
          decision: "skip",
          reason: subagentNeed.reason,
          ...subagentNeed.signals,
        },
      });
    }
    if (!subagentNeed.useSubagents) {
      yield* paceReasoningText(ctx, `Skipping parallel subagents: ${subagentNeed.reason}.\n\n`);
      const synthStart = performance.now();
      yield* this.responseFuser.fuseStream(ctx, imageResults);
      streamSteps.push({
        type: "synthesis",
        label: "Response Synthesis",
        durationMs: Math.round(performance.now() - synthStart),
        modelRouting: ctx.fusionConfig.fusion.model_routing,
      });
      setStreamTrace([], false, undefined);
      return;
    }

    // Layer 3: Divide the task
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "task_division",
      status: "started",
      modelRouting: ctx.fusionConfig.task_divider.model_routing,
    });
    yield* paceReasoningText(
      ctx,
      "Breaking the request down into focused research sub-tasks before spawning subagents.\n\n",
    );
    const divStart = performance.now();
    const subTasks = await this.taskDivider.divide(ctx);
    const divMs = Math.round(performance.now() - divStart);
    log.info(`task divided into ${subTasks.length} sub-tasks`);
    streamSteps.push({
      type: "task_division",
      label: "Task Division",
      durationMs: divMs,
      modelRouting: ctx.fusionConfig.task_divider.model_routing,
    });
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "task_division",
      status: "completed",
      durationMs: divMs,
      modelRouting: ctx.fusionConfig.task_divider.model_routing,
      detail: { subTaskCount: subTasks.length },
    });
    emitFusion(ctx, {
      type: "fusion.subtasks",
      at: nowIso(),
      subTasks: subTasks.map((t) => ({
        id: t.id,
        focus: t.focus_area,
        model: t.suggested_model_routing,
        description: t.description.slice(0, 200),
      })),
    });

    // Layer 1: Check reasoning cache
    const cacheKey = cacheEnabled ? this.reasoningCache.computeKey(ctx, subTasks) : undefined;
    const cachedEntry = cacheKey !== undefined ? this.reasoningCache.get(cacheKey) : null;
    if (cacheKey !== undefined) {
      emitFusion(ctx, {
        type: "fusion.cache",
        at: nowIso(),
        kind: "subtask",
        hit: !!cachedEntry,
      });
    }

    let subagentResults: SubagentResult[];

    if (cachedEntry) {
      log.info("cache hit — reconstructing subagent results", { key: cacheKey });
      subagentResults = cachedEntry.subagentResults;
      streamSteps.push({ type: "cache_lookup", label: "Sub-task Cache Hit", durationMs: 0 });
      this.emitReusedSubagentEvents(ctx, subagentResults, "subtask", cachedEntry.key);
      yield* paceReasoningText(
        ctx,
        `Recalling ${subagentResults.length} cached deep-reasoning result(s); skipping duplicate subagent execution.\n\n`,
      );
    } else {
      // Layer 4: Execute subagents, streaming live reasoning summaries while
      // they work. Segments flow through the turbo summarizer serially and
      // are yielded to the client's reasoning channel as they generate.
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "subagent_execution",
        status: "started",
        detail: { count: subTasks.length },
      });
      const execStart = performance.now();
      const pump = this.summarizer.isEnabled(ctx)
        ? new SummaryPump(this.summarizer, ctx, {
            onSummary: (label, text) =>
              emitFusion(ctx, { type: "fusion.summary", at: nowIso(), label, text }),
          })
        : undefined;

      const execPromise = this.subagentExecutor
        .execute(ctx, subTasks, {
          onGoalpost: (event) => this.emitGoalpostSummary(event, ctx),
          onSegment: pump !== undefined ? (segment) => pump.enqueue(segment) : undefined,
        })
        .finally(() => pump?.finish());

      if (pump !== undefined) {
        for await (const chunk of pump.chunks()) {
          yield chunk;
        }
      }
      subagentResults = await execPromise;

      const succeeded = subagentResults.filter((r) => r.success).length;
      const execMs = Math.round(performance.now() - execStart);
      log.info(`subagent execution complete: ${succeeded}/${subTasks.length} succeeded`);
      streamSteps.push({ type: "subagent_execution", label: "Subagent Execution", durationMs: execMs });
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "subagent_execution",
        status: "completed",
        durationMs: execMs,
        detail: { total: subagentResults.length, succeeded },
      });
    }

    // Prepend image descriptions as synthetic subagent results
    const combined = [...imageResults, ...subagentResults];
    log.info(`synthesizing ${combined.length} subagent outputs`);

    // Layer 5: Fuse with streaming — raw synthesis reasoning is intercepted
    // and summarized inside fuseStream; content/tool_calls pass through.
    const synthStart = performance.now();
    yield* this.responseFuser.fuseStream(ctx, combined);
    streamSteps.push({
      type: "synthesis",
      label: "Response Synthesis",
      durationMs: Math.round(performance.now() - synthStart),
      modelRouting: ctx.fusionConfig.fusion.model_routing,
    });
    setStreamTrace(subagentResults, !!cachedEntry, cacheKey);

    // Store in cache if not already cached
    if (!cachedEntry && cacheKey !== undefined && this.shouldCacheSubagentResults(subagentResults)) {
      this.reasoningCache.set(cacheKey, subagentResults, subTasks, score, undefined, requestCacheKey, {
        conversationId: ctx.conversationId,
        messages: ctx.messages,
      });
    }
  }

  // ── Effort 1 Handler ──────────────────────────────────────────────

  private extractToolCallsFromResponse(response: Record<string, unknown>): {
    content: string | null;
    reasoning: string | undefined;
    reasoningContent: string | undefined;
    toolCalls: unknown[] | undefined;
    finishReason: string | undefined;
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  } {
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      return {
        content: JSON.stringify(response),
        reasoning: undefined,
        reasoningContent: undefined,
        toolCalls: undefined,
        finishReason: undefined,
      };
    }

    const choice = choices[0];
    const message = choice["message"] as Record<string, unknown> | undefined;
    const finishReason = choice["finish_reason"] as string | undefined;

    if (!message) {
      return {
        content: JSON.stringify(response),
        reasoning: undefined,
        reasoningContent: undefined,
        toolCalls: undefined,
        finishReason,
      };
    }

    const toolCalls = message["tool_calls"] as unknown[] | undefined;
    const reasoning = typeof message["reasoning"] === "string" ? message["reasoning"] : undefined;
    const reasoningContent = typeof message["reasoning_content"] === "string" ? message["reasoning_content"] : undefined;
    const content = toolCalls && toolCalls.length > 0
      ? null
      : (message["content"] as string ?? JSON.stringify(response));

    // Extract usage from response
    const usageObj = response["usage"] as Record<string, unknown> | undefined;
    const usage = usageObj ? {
      promptTokens: Number(usageObj["prompt_tokens"] ?? 0),
      completionTokens: Number(usageObj["completion_tokens"] ?? 0),
      totalTokens: Number(usageObj["total_tokens"] ?? 0),
    } : undefined;

    return { content, reasoning, reasoningContent, toolCalls, finishReason, usage };
  }

  private async handleEffort1(
    ctx: FusionRequestContext,
    score: ComplexityScore,
    steps: FusionStep[],
    costs: FusionCostEntry[],
  ): Promise<FusionResult> {
    const { fusionConfig, requestData, clientProtocol, signal } = ctx;
    const modelRouting = fusionConfig.effort_levels[1].model_routing;

    log.info("effort 1: delegating to fallback router", { modelRouting });

    const stepStart = performance.now();
    try {
      const response = await this.fallbackRouter.callWithFallback({
        logicalModel: modelRouting,
        requestData,
        targetProtocol: clientProtocol,
        signal,
        principal: ctx.principal,
        extraHeaders: ctx.extraHeaders,
      });

      const { content, reasoning, reasoningContent, toolCalls, finishReason, usage } = this.extractToolCallsFromResponse(response);

      steps.push({
        type: "effort_1_fast_path",
        label: "Effort 1 Fast Path",
        startedAt: new Date(Date.now() - (performance.now() - stepStart)).toISOString(),
        durationMs: Math.round(performance.now() - stepStart),
        modelRouting,
        details: {
          usage,
          hasToolCalls: !!(toolCalls && toolCalls.length > 0),
          contentLength: content?.length ?? 0,
        },
      });

      // Record cost for this call
      if (usage) {
        const pricing = resolvePricing({ requestedModel: modelRouting });
        const costResult = calculateCosts(usageSnapshotFromCounts(usage), pricing);
        costs.push({
          modelRouting,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          userCostUsd: costResult.userCostUsd,
          typicalCostUsd: costResult.typicalCostUsd,
        });
      }

      return {
        content,
        reasoning,
        reasoningContent,
        toolCalls,
        finishReason,
        wireProtocol: clientProtocol,
        subagentResults: [],
        fusedByModelRouting: modelRouting,
        usage,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("context") || errMsg.includes("token") || errMsg.includes("length")) {
        log.info("effort 1 context exceeded, escalating to effort 2", { err: errMsg });
        return this.executeFusionPipeline(ctx, score, steps, costs);
      }
      throw err;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private prepareRuntimeContext(ctx: FusionRequestContext): void {
    captureFusionEmitter(ctx);
    ctx.requestId ??= currentRequestId() ?? `fusion-${Date.now()}`;
    const identity = resolveFusionIdentity({
      requestId: ctx.requestId,
      messages: ctx.messages,
      logicalModel: ctx.logicalModel,
      principalId: ctx.principal?.id,
      extraHeaders: ctx.extraHeaders,
    });
    ctx.conversationId ??= identity.conversationId;
    ctx.turnId ??= identity.turnId;
    ctx.inputFingerprint ??= identity.inputFingerprint;
    const runtimeIdentity = {
      ...identity,
      conversationId: ctx.conversationId,
      turnId: ctx.turnId,
      inputFingerprint: ctx.inputFingerprint,
    };
    ctx.fusionRunId ??= makeFusionRunId(ctx.requestId);
    const scheduler = ctx.fusionConfig.scheduler;
    ctx.execution ??= {
      depth: 0,
      maxDepth: scheduler.max_depth,
      remainingLeafCalls: scheduler.max_leaf_calls,
      remainingTokens: ctx.fusionConfig.context_window,
      remainingMs: scheduler.max_wall_ms,
      allowNestedFusion: scheduler.allow_nested_fusion,
    };
    try {
      recordFusionConversationTurn({
        identity: runtimeIdentity,
        requestId: ctx.requestId,
        principalId: ctx.principal?.id,
      });
    } catch (err) {
      log.warn("failed to record fusion conversation turn", { error: String(err) });
    }
  }

  private evaluateSubagentNeed(
    ctx: FusionRequestContext,
    score: ComplexityScore,
  ): SubagentNeedDecision {
    const runtimeEffort = ctx.runtimeEffort ?? score.effort;
    const requestData = ctx.requestData;
    const tools = Array.isArray(requestData["tools"]) ? requestData["tools"] : [];
    const toolChoice = requestData["tool_choice"];
    const toolUseAllowed = toolChoice !== "none" && tools.length > 0;
    const messageCount = ctx.messages.length;
    const text = JSON.stringify(ctx.messages).toLowerCase();
    const hasCodeOrFileWork =
      /\b(refactor|implement|edit|modify|patch|debug|fix|test|typescript|javascript|tsx|schema|database|migration|api|route|component)\b/.test(text);
    const referencedFiles = text.match(/\b[\w./-]+\.(?:ts|tsx|js|jsx|json|md|css|py|go|rs|java|kt|sql|ya?ml)\b/g) ?? [];
    const hasLargeEditIntent =
      /\b(multi[-\s]?file|multiple files|across (?:the )?(?:repo|repository|codebase|modules|packages)|large (?:file )?(?:edit|refactor|migration)|end[-\s]?to[-\s]?end|full implementation|repo[-\s]?wide|repository[-\s]?wide)\b/.test(text) ||
      /\b(refactor|implement|migrate|update)\b[\s\S]{0,160}\b(tests?|docs?|schemas?|routes?|components?|providers?|configs?)\b/.test(text) ||
      referencedFiles.length >= 3;
    const toolResultMessages = ctx.messages.filter((msg) =>
      typeof msg === "object" &&
      msg !== null &&
      ((msg as Record<string, unknown>)["role"] === "tool" ||
        (Array.isArray((msg as Record<string, unknown>)["content"]) &&
          ((msg as Record<string, unknown>)["content"] as unknown[]).some((part) =>
            typeof part === "object" && part !== null && (part as Record<string, unknown>)["type"] === "tool_result"))));
    const hasToolResults = toolResultMessages.length > 0;
    const toolDeltaClassification = hasToolResults
      ? classifyConversationDelta(ctx.messages, toolResultMessages)
      : undefined;
    const significantToolResults = toolDeltaClassification?.significant === true;
    const declaredFusionContextWindow = this.resolveDeclaredContextWindow(ctx.fusionConfig.fusion.model_routing);
    const activeFusionContextWindow = this.activeFusionContextWindow(ctx, declaredFusionContextWindow);
    const largeContextThreshold = this.largeContextThreshold(activeFusionContextWindow);
    const largeContext = score.tokenCount >= largeContextThreshold;
    const manyTools = toolUseAllowed && tools.length >= 8;
    const longConversation = messageCount >= 10;
    const explicitHigh = ctx.resolvedFusionEffort === "F3";
    const images = ctx.hadImages === true || (ctx.imageDescriptions?.length ?? 0) > 0;

    const signals = this.buildSubagentDecisionSignals({
      runtimeEffort,
      fusionEffort: ctx.resolvedFusionEffort,
      tokenCount: score.tokenCount,
      messageCount,
      toolCount: tools.length,
      toolUseAllowed,
      declaredFusionContextWindow,
      activeFusionContextWindow,
      largeContextThreshold,
      largeContext,
      manyTools,
      longConversation,
      hasToolResults,
      significantToolResults,
      toolResultReason: toolDeltaClassification?.reason,
      hasCodeOrFileWork,
      hasLargeEditIntent,
      referencedFileCount: referencedFiles.length,
      images,
    });

    if (runtimeEffort <= 1) {
      return { useSubagents: false, reason: "fast-path effort does not use subagents", signals };
    }
    if (explicitHigh) {
      return { useSubagents: true, reason: "F3/high effort explicitly requires parallel deep reasoning", signals };
    }
    if (images) {
      return { useSubagents: true, reason: "image-derived context requires dedicated reasoning before synthesis", signals };
    }
    if (largeContext) {
      return { useSubagents: true, reason: "large context benefits from parallel context triage", signals };
    }
    if (manyTools) {
      return { useSubagents: true, reason: "large tool surface benefits from parallel risk analysis", signals };
    }
    if (hasCodeOrFileWork && hasLargeEditIntent) {
      return { useSubagents: true, reason: "large implementation plan benefits from parallel review before synthesis", signals };
    }
    if (significantToolResults && (hasCodeOrFileWork || score.tokenCount >= 8_000)) {
      return { useSubagents: true, reason: "tool results introduced substantial implementation context", signals };
    }
    if (longConversation && hasCodeOrFileWork) {
      return { useSubagents: true, reason: "multi-turn implementation context benefits from parallel review", signals };
    }

    return {
      useSubagents: false,
      reason: "moderate request is within synthesis model context; subagents would add latency without clear benefit",
      signals,
    };
  }

  private buildSubagentDecisionSignals(args: {
    runtimeEffort: number;
    fusionEffort?: string;
    tokenCount: number;
    messageCount: number;
    toolCount: number;
    toolUseAllowed: boolean;
    declaredFusionContextWindow: number;
    activeFusionContextWindow: number;
    largeContextThreshold: number;
    largeContext: boolean;
    manyTools: boolean;
    longConversation: boolean;
    hasToolResults: boolean;
    significantToolResults: boolean;
    toolResultReason?: string;
    hasCodeOrFileWork: boolean;
    hasLargeEditIntent: boolean;
    referencedFileCount: number;
    images: boolean;
  }): SubagentDecisionSignals {
    const activeTriggers: string[] = [];
    const suppressors: string[] = [];

    if (args.runtimeEffort <= 1) suppressors.push("fast-path effort");
    if (args.fusionEffort === "F3") activeTriggers.push("F3 high effort");
    if (args.images) activeTriggers.push("image context");
    if (args.largeContext) activeTriggers.push("large context");
    if (args.manyTools) activeTriggers.push("large tool surface");
    if (args.hasCodeOrFileWork && args.hasLargeEditIntent) activeTriggers.push("large implementation intent");
    if (args.significantToolResults) activeTriggers.push("significant tool results");
    if (args.longConversation && args.hasCodeOrFileWork) activeTriggers.push("multi-turn implementation context");

    if (!args.largeContext) suppressors.push("context fits synthesis route");
    if (args.toolCount > 0 && !args.toolUseAllowed) suppressors.push("tool use disabled");
    if (args.toolCount > 0 && args.toolUseAllowed && !args.manyTools) suppressors.push("tool surface below parallel threshold");
    if (args.hasToolResults && !args.significantToolResults) suppressors.push("tool results are trivial");
    if (args.hasCodeOrFileWork && !args.hasLargeEditIntent && !args.longConversation) suppressors.push("implementation scope is local");
    if (activeTriggers.length === 0 && args.runtimeEffort > 1) suppressors.push("no strong parallel-reasoning trigger");

    return {
      runtimeEffort: args.runtimeEffort,
      fusionEffort: args.fusionEffort,
      tokenCount: args.tokenCount,
      messageCount: args.messageCount,
      toolCount: args.toolCount,
      toolUseAllowed: args.toolUseAllowed,
      declaredFusionContextWindow: args.declaredFusionContextWindow,
      activeFusionContextWindow: args.activeFusionContextWindow,
      largeContextThreshold: args.largeContextThreshold,
      contextLoadPercent: Math.round((args.tokenCount / Math.max(1, args.largeContextThreshold)) * 1000) / 10,
      largeContext: args.largeContext,
      manyTools: args.manyTools,
      longConversation: args.longConversation,
      hasToolResults: args.hasToolResults,
      significantToolResults: args.significantToolResults,
      toolResultReason: args.toolResultReason,
      hasCodeOrFileWork: args.hasCodeOrFileWork,
      hasLargeEditIntent: args.hasLargeEditIntent,
      referencedFileCount: args.referencedFileCount,
      images: args.images,
      activeTriggers,
      suppressors: [...new Set(suppressors)],
    };
  }

  private activeFusionContextWindow(ctx: FusionRequestContext, declaredContextWindow: number): number {
    return Math.max(4096, Math.min(ctx.fusionConfig.context_window, declaredContextWindow));
  }

  private emitReusedSubagentEvents(
    ctx: FusionRequestContext,
    results: SubagentResult[],
    cacheKind: "request" | "conversation" | "subtask",
    cacheKey: string,
    extraDetail?: Record<string, unknown>,
  ): void {
    this.recordReusedSubagentRuns(ctx, results, cacheKind, cacheKey, extraDetail);
    emitFusion(ctx, {
      type: "fusion.subtasks",
      at: nowIso(),
      subTasks: results.map((r) => ({
        id: r.subTask.id,
        focus: r.subTask.focus_area,
        model: r.usedModelRouting,
        description: r.subTask.description.slice(0, 200),
      })),
    });
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "subagent_execution",
      status: "completed",
      detail: {
        decision: "reuse",
        cacheKind,
        cacheKey,
        total: results.length,
        succeeded: results.filter((r) => r.success).length,
        ...extraDetail,
      },
    });
    for (const result of results) {
      emitFusion(ctx, {
        type: "fusion.subagent",
        at: nowIso(),
        id: result.subTask.id,
        focus: result.subTask.focus_area,
        model: result.usedModelRouting,
        status: result.success ? "completed" : "failed",
        chars: result.content.length,
        durationMs: result.durationMs,
        error: result.error,
        detail: {
          stage: "cache_reused",
          cacheKind,
          cacheKey,
          contextWindow: result.contextWindow,
          inputBudgetTokens: result.inputBudgetTokens,
          outputBudgetTokens: result.outputBudgetTokens,
          contextMessageCount: result.contextMessageCount,
          droppedMessageCount: result.droppedMessageCount,
          packedContextTokens: result.packedContextTokens,
          contextPack: result.contextPack,
          ...extraDetail,
        },
      });
    }
  }

  private recordReusedSubagentRuns(
    ctx: FusionRequestContext,
    results: SubagentResult[],
    cacheKind: "request" | "conversation" | "subtask",
    cacheKey: string,
    extraDetail?: Record<string, unknown>,
  ): void {
    if (!ctx.fusionRunId) return;
    for (const result of results) {
      const subagentRunId = makeFusionSubagentRunId(ctx.fusionRunId, result.subTask.id);
      try {
        startFusionSubagentRun({
          subagentRunId,
          fusionRunId: ctx.fusionRunId,
          parentRunId: ctx.execution?.parentRunId,
          subtaskId: result.subTask.id,
          focusArea: result.subTask.focus_area,
          descriptionHash: hashFusionValue(result.subTask.description),
          modelRouting: result.usedModelRouting,
          metadata: {
            depth: ctx.execution?.depth ?? 0,
            cacheKind,
            cacheKey,
            reusedFromSubagentRunId: result.subagentRunId,
            ...extraDetail,
          },
        });
        finishFusionSubagentRun({
          subagentRunId,
          status: "cached",
          attemptCount: 0,
          durationMs: 0,
          outputHash: result.content ? hashFusionValue(result.content) : undefined,
          metadata: {
            cacheKind,
            cacheKey,
            reusedFromSubagentRunId: result.subagentRunId,
            contextPack: result.contextPack,
            ...extraDetail,
          },
        });
      } catch (err) {
        log.warn("failed to record reused fusion subagent run", {
          fusionRunId: ctx.fusionRunId,
          subagentRunId,
          cacheKind,
          error: String(err),
        });
      }
    }
  }

  private largeContextThreshold(activeContextWindow: number): number {
    return Math.max(8_000, Math.min(160_000, Math.floor(activeContextWindow * 0.35)));
  }

  private resolveDeclaredContextWindow(modelRouting: string): number {
    try {
      const cfg = modelConfigLoader.loadConfig(modelRouting);
      const primary = cfg.model_routings[0];
      return primary?.context_window ?? cfg.context_window ?? 128_000;
    } catch {
      return 128_000;
    }
  }

  private shouldCacheSubagentResults(results: SubagentResult[]): boolean {
    return results.length > 0 && results.every((result) => result.success && result.content.trim().length > 0);
  }

  private startRun(
    ctx: FusionRequestContext,
    effort: number,
    score: ComplexityScore,
  ): void {
    if (!ctx.fusionRunId || !ctx.requestId || !ctx.turnId || !ctx.conversationId || !ctx.inputFingerprint) {
      return;
    }
    try {
      startFusionRun({
        fusionRunId: ctx.fusionRunId,
        requestId: ctx.requestId,
        turnId: ctx.turnId,
        conversationId: ctx.conversationId,
        logicalModel: ctx.logicalModel,
        effort: score.fusionEffort ?? String(effort),
        inputFingerprint: ctx.inputFingerprint,
        configFingerprint: hashFusionValue(ctx.fusionConfig),
        metadata: {
          score: score.score,
          reason: score.reason,
          tokenCount: score.tokenCount,
          execution: ctx.execution,
        },
      });
    } catch (err) {
      log.warn("failed to start fusion run", { fusionRunId: ctx.fusionRunId, error: String(err) });
    }
  }

  private finishRun(
    ctx: FusionRequestContext,
    status: "completed" | "failed",
    result?: FusionResult,
    metadata?: Record<string, unknown>,
  ): void {
    if (!ctx.fusionRunId) return;
    try {
      finishFusionRun({
        fusionRunId: ctx.fusionRunId,
        status,
        cacheKey: result?.cacheKey,
        cacheHit: result?.cacheHit,
        metadata: {
          ...metadata,
          fusedByModelRouting: result?.fusedByModelRouting,
          subagentCount: result?.subagentResults.length,
        },
      });
    } catch (err) {
      log.warn("failed to finish fusion run", { fusionRunId: ctx.fusionRunId, error: String(err) });
    }
  }

  private emitGoalpostSummary(event: GoalpostEvent, _ctx: FusionRequestContext): void {
    log.debug("goalpost event", {
      type: event.type,
      subagentId: event.subagentId,
    });
  }

  private makeImageDescriptionResults(ctx: FusionRequestContext): SubagentResult[] {
    if (!ctx.hadImages || !ctx.imageDescriptions || ctx.imageDescriptions.length === 0) return [];
    return ctx.imageDescriptions.map((desc, i) => ({
      subTask: {
        id: `image-desc-${i + 1}`,
        description: "Provide a detailed textual description of the user-provided image(s) so that text-only models can reason about visual content.",
        focus_area: "vision",
        suggested_model_routing: "kimi-k2.7-code",
      },
      success: true,
      usedModelRouting: "kimi-k2.7-code",
      content: desc,
      durationMs: 0,
    }));
  }
}
