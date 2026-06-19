import { createLogger } from "../../observability/logger.ts";
import { ComplexityScorer } from "./complexity-scorer.ts";
import { TaskDividerAgent } from "./task-divider.ts";
import { SubagentExecutor } from "./subagent-executor.ts";
import { ResponseFuser } from "./response-fuser.ts";
import { ReasoningCache } from "./reasoning-cache.ts";
import type {
  ComplexityScore,
  FusionRequestContext,
  FusionResult,
  GoalpostEvent,
  SubagentResult,
} from "./types.ts";
import { FallbackRouter } from "../fallback.ts";

const log = createLogger("routing.fusion");

// ── FusionRouter ──────────────────────────────────────────────────────

/**
 * Top-level orchestrator for the Model Fusion (Beta) feature.
 *
 * Handles the full 5-layer pipeline:
 *   Layer 1: Reasoning cache lookup
 *   Layer 2: Complexity scoring → effort determination
 *   Layer 3: Task division (agentic, tool-calling)
 *   Layer 4: Parallel subagent execution
 *   Layer 5: Response fusion (sequential append + synthesis)
 */
export class FusionRouter {
  private readonly fallbackRouter: FallbackRouter;
  private readonly complexityScorer: ComplexityScorer;
  private readonly taskDivider: TaskDividerAgent;
  private readonly subagentExecutor: SubagentExecutor;
  private readonly responseFuser: ResponseFuser;
  private readonly reasoningCache: ReasoningCache;

  constructor() {
    this.fallbackRouter = new FallbackRouter();
    this.complexityScorer = new ComplexityScorer();
    this.taskDivider = new TaskDividerAgent();
    this.subagentExecutor = new SubagentExecutor();
    this.responseFuser = new ResponseFuser();
    this.reasoningCache = new ReasoningCache();
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Execute a fusion request non-streaming.
   */
  async route(ctx: FusionRequestContext): Promise<FusionResult> {
    const { clientProtocol, logicalModel } = ctx;

    log.info("fusion route start", { logicalModel, clientProtocol });

    // Layer 2: Score complexity
    const score = this.complexityScorer.score(ctx);

    // Route based on effort level
    switch (score.effort) {
      case 1:
        return this.handleEffort1(ctx, score);
      case 2:
        return this.executeFusionPipeline(ctx, score);
      case 3:
        return this.executeFusionPipeline(ctx, score);
    }
  }

  /**
   * Execute a fusion request with streaming.
   */
  async *stream(ctx: FusionRequestContext): AsyncGenerator<string, void, unknown> {
    const { fusionConfig, requestData, clientProtocol, logicalModel } = ctx;

    log.info("fusion stream start", { logicalModel, clientProtocol });

    // Layer 2: Score complexity
    const score = this.complexityScorer.score(ctx);

    // Yield initial reasoning event
    yield this.encodeSSE("reasoning", {
      type: "reasoning",
      summary: `[Fusion] Assessing task complexity... (score: ${score.score.toFixed(2)}, effort: ${score.effort})`,
    });

    switch (score.effort) {
      case 1:
        log.info("effort 1: delegating to fallback router");
        yield this.encodeSSE("reasoning", {
          type: "reasoning",
          summary: `[Fusion] Task appears straightforward (score ${score.score.toFixed(2)}). Using fast path via ${fusionConfig.effort_levels[1].model_routing}.`,
        });

        const streamGen = this.fallbackRouter.streamWithFallback({
          logicalModel: fusionConfig.effort_levels[1].model_routing,
          requestData,
          targetProtocol: clientProtocol,
          signal: ctx.signal,
        });

        for await (const chunk of streamGen) {
          yield chunk;
        }
        return;

      case 2:
      case 3:
        yield* this.executeFusionPipelineStream(ctx, score);
        return;
    }
  }

  // ── Full Fusion Pipeline (non-streaming) ──────────────────────────

  /**
   * Execute the full 5-layer fusion pipeline for Effort 2 and 3.
   */
  private async executeFusionPipeline(
    ctx: FusionRequestContext,
    score: ComplexityScore,
  ): Promise<FusionResult> {
    const effort = score.effort;

    log.info(`effort ${effort}: executing fusion pipeline`);

    // Layer 3: Divide the task
    const subTasks = await this.taskDivider.divide(ctx);
    log.info(`task divided into ${subTasks.length} sub-tasks`);

    // Layer 1: Check reasoning cache
    const cacheKey = this.reasoningCache.computeKey(ctx, subTasks);
    const cachedEntry = this.reasoningCache.get(cacheKey);
    if (cachedEntry) {
      log.info("cache hit — reconstructing subagent results", { key: cacheKey });
      // Cache hit: use cached subagent results, skip to fusion
      const fusionResult = await this.responseFuser.fuse(ctx, cachedEntry.subagentResults);
      return fusionResult;
    }

    // Layer 4: Execute subagents in parallel
    const subagentResults = await this.subagentExecutor.execute(ctx, subTasks);
    const succeeded = subagentResults.filter((r) => r.success).length;
    log.info(`subagent execution complete: ${succeeded}/${subTasks.length} succeeded`);

    // Layer 5: Fuse responses
    const fusionResult = await this.responseFuser.fuse(ctx, subagentResults);

    // Store in cache
    this.reasoningCache.set(cacheKey, subagentResults, subTasks, score, fusionResult.content);

    return fusionResult;
  }

  // ── Full Fusion Pipeline (streaming) ──────────────────────────────

  /**
   * Execute the fusion pipeline with streaming SSE events.
   */
  private async *executeFusionPipelineStream(
    ctx: FusionRequestContext,
    score: ComplexityScore,
  ): AsyncGenerator<string, void, unknown> {
    const effort = score.effort;

    yield this.encodeSSE("reasoning", {
      type: "reasoning",
      summary: `[Fusion] Task complexity requires effort level ${effort}. Starting task analysis and division...`,
    });

    // Layer 3: Divide the task
    const subTasks = await this.taskDivider.divide(ctx);
    yield this.encodeSSE("reasoning", {
      type: "reasoning",
      summary: `[Fusion] Divided task into ${subTasks.length} sub-tasks. Starting parallel subagent execution...`,
    });

    // Layer 1: Check reasoning cache
    const cacheKey = this.reasoningCache.computeKey(ctx, subTasks);
    const cachedEntry = this.reasoningCache.get(cacheKey);

    let subagentResults: SubagentResult[];

    if (cachedEntry) {
      log.info("cache hit — reconstructing subagent results", { key: cacheKey });
      yield this.encodeSSE("reasoning", {
        type: "reasoning",
        summary: `[Fusion] Cache hit! Reconstructing ${cachedEntry.subagentResults.length} prior subagent results.`,
      });
      subagentResults = cachedEntry.subagentResults;
    } else {
      // Layer 4: Execute subagents with goalpost streaming
      const goalpostStream: GoalpostEvent[] = [];
      subagentResults = await this.subagentExecutor.execute(ctx, subTasks, {
        onGoalpost: (event) => {
          goalpostStream.push(event);
          // Stream reasoning summary to client
          this.emitGoalpostSummary(event, ctx);
        },
      });

      const succeeded = subagentResults.filter((r) => r.success).length;
      yield this.encodeSSE("reasoning", {
        type: "reasoning",
        summary: `[Fusion] Subagent execution complete: ${succeeded}/${subTasks.length} succeeded. Synthesizing final response...`,
      });
    }

    // Layer 5: Fuse with streaming
    yield this.encodeSSE("reasoning", {
      type: "reasoning",
      summary: `[Fusion] Synthesizing ${subagentResults.filter(r => r.success).length} subagent outputs into final response...`,
    });

    // Use the fuser's stream method for the final synthesis
    yield* this.responseFuser.fuseStream(ctx, subagentResults);

    // Store in cache if not already cached
    if (!cachedEntry) {
      this.reasoningCache.set(cacheKey, subagentResults, subTasks, score);
    }
  }

  // ── Effort 1 Handler ──────────────────────────────────────────────

  private async handleEffort1(
    ctx: FusionRequestContext,
    score: ComplexityScore,
  ): Promise<FusionResult> {
    const { fusionConfig, requestData, clientProtocol, signal } = ctx;
    const modelRouting = fusionConfig.effort_levels[1].model_routing;

    log.info("effort 1: delegating to fallback router", { modelRouting });

    try {
      const response = await this.fallbackRouter.callWithFallback({
        logicalModel: modelRouting,
        requestData,
        targetProtocol: clientProtocol,
        signal,
      });

      return {
        content: JSON.stringify(response),
        wireProtocol: clientProtocol,
        subagentResults: [],
        fusedByModelRouting: modelRouting,
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("context") || errMsg.includes("token") || errMsg.includes("length")) {
        log.info("effort 1 context exceeded, escalating to effort 2", { err: errMsg });
        return this.executeFusionPipeline(ctx, score);
      }
      throw err;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Emit a goalpost-triggered reasoning summary to the client.
   * In this implementation, returns the event as a log entry since
   * the subagent-executor already calls the onGoalpost callback
   * which we use to stream SSE events.
   */
  private emitGoalpostSummary(event: GoalpostEvent, _ctx: FusionRequestContext): void {
    log.debug("goalpost event", {
      type: event.type,
      subagentId: event.subagentId,
    });
  }

  /**
   * Encode a structured event as an SSE data frame.
   */
  private encodeSSE(_eventType: string, data: unknown): string {
    return `data: ${JSON.stringify(Object.assign({ event: _eventType }, data))}\n\n`;
  }
}
