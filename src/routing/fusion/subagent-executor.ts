import { createLogger } from "../../observability/logger.ts";
import { modelConfigLoader } from "../../config/model-loader.ts";
import { FallbackRouter } from "../fallback.ts";
import type { FusionRequestContext, SubTask, SubagentResult, GoalpostEvent } from "./types.ts";
import {
  parseOpenAIDelta,
  splitSseEvents,
  stripToolCallArtifacts,
  type SummarySegment,
} from "./reasoning-summarizer.ts";
import { SYSTEM_DEFAULT_CONTEXT_WINDOW } from "../context-window.ts";
import { emitFusion, nowIso } from "./fusion-events.ts";
import {
  finishFusionSubagentRun,
  hashFusionValue,
  makeFusionSubagentRunId,
  startFusionSubagentRun,
} from "../../storage/fusion-store.ts";

const log = createLogger("routing.fusion.subagent");

/** Maximum retries per subagent before giving up. */
const MAX_SUBAGENT_RETRIES = 3;

/** Delay between retries (ms). */
const RETRY_DELAY_MS = 500;

/** Default max output tokens for subagents — large enough for 1M-context models. */
const DEFAULT_MAX_OUTPUT_TOKENS = 131072;

/** Max input messages to include (safety ceiling). */
const MAX_CONTEXT_MESSAGES = 200;

/** Minimum input budget to reserve for subagent context, even for small local models. */
const MIN_SUBAGENT_INPUT_TOKENS = 8_000;

/** Output headroom is important, but should not consume the whole context on smaller models. */
const MAX_OUTPUT_RESERVE_RATIO = 0.25;

/** Minimum trailing characters worth flushing as a final summary segment. */
const MIN_FLUSH_SEGMENT_CHARS = 120;

/** Minimum buffered characters before a paragraph boundary triggers an early flush. */
const MIN_PARAGRAPH_FLUSH_CHARS = 500;

/** Rough token estimate: chars / 4. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate the total token count for an array of messages.
 */
function estimateMessageTokens(messages: unknown[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(JSON.stringify(msg));
  }
  return total;
}

// ── Goalpost patterns ─────────────────────────────────────────────────

const GOALPOST_PATTERNS = [
  { type: "tool_call", pattern: /function|tool_use|tool_call/i },
  { type: "assistant_response", pattern: /therefore|in conclusion|to summarize|here('s| is) (the|my)/i },
  { type: "reasoning_step", pattern: /step \d|firstly|secondly|finally|next,|now, |let me/i },
  { type: "decision", pattern: /i (will|should|recommend|choose|decide)/i },
  { type: "finding", pattern: /found|identified|discovered|determined|analyzed/i },
];

// ── Streaming tool-call accumulation ──────────────────────────────────

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface SubagentContextBudget {
  contextWindow: number;
  inputBudgetTokens: number;
  outputBudgetTokens: number;
}

interface SubagentMessagePack {
  messages: unknown[];
  contextMessageCount: number;
  droppedMessageCount: number;
  packedContextTokens: number;
}

/** Merge OpenAI streaming tool_call deltas into complete calls. */
function mergeToolCallDeltas(
  acc: Map<number, AccumulatedToolCall>,
  deltas: Array<Record<string, unknown>>,
): void {
  for (const delta of deltas) {
    const index = typeof delta["index"] === "number" ? delta["index"] : 0;
    const entry = acc.get(index) ?? { id: "", name: "", arguments: "" };
    if (typeof delta["id"] === "string" && delta["id"].length > 0) {
      entry.id = delta["id"];
    }
    const fn = delta["function"] as Record<string, unknown> | undefined;
    if (fn !== undefined) {
      if (typeof fn["name"] === "string" && fn["name"].length > 0) {
        entry.name += fn["name"];
      }
      if (typeof fn["arguments"] === "string") {
        entry.arguments += fn["arguments"];
      }
    }
    acc.set(index, entry);
  }
}

// ── SubagentExecutor ──────────────────────────────────────────────────

/**
 * Layer 4: Parallel Subagent Execution
 *
 * Takes divided sub-tasks and executes each one as a parallel subagent
 * using existing model routings. Supports:
 *  - Full context passthrough (no arbitrary truncation of messages)
 *  - Large output token budgets (131K) for 1M-context models
 *  - Token-aware message selection (drops oldest messages first if needed)
 *  - Parallel execution with configurable concurrency
 *  - Automatic retry on failure
 *  - Streaming execution with live summary segments (onSegment)
 * Subagents are research/reasoning-only and receive NO tool schemas. The proxy
 * pre-triages the conversation into a model-budgeted context packet before the
 * call. Their output is advisory input for the final fusion model, which is the
 * only entity that produces user-facing responses and real tool calls.
 */
export class SubagentExecutor {
  private readonly fallbackRouter: FallbackRouter;

  constructor() {
    this.fallbackRouter = new FallbackRouter();
  }

  /**
   * Execute all sub-tasks in parallel.
   */
  async execute(
    ctx: FusionRequestContext,
    subTasks: SubTask[],
    options: {
      onGoalpost?: (event: GoalpostEvent) => void;
      /** Live segments of the subagent's raw output/reasoning as it streams. */
      onSegment?: (segment: SummarySegment) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<SubagentResult[]> {
    const tasks = this.resolveExecutableTasks(ctx, subTasks);
    if (ctx.execution !== undefined) {
      ctx.execution.remainingLeafCalls = Math.max(0, ctx.execution.remainingLeafCalls - tasks.length);
    }

    if (tasks.length === 0) {
      log.warn("no sub-tasks to execute");
      return [];
    }

    log.info("executing subagents", { count: tasks.length, tools: [] });

    const results = await Promise.allSettled(
      tasks.map((subTask) => this.executeSingle(ctx, subTask, options)),
    );

    const subagentResults: SubagentResult[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const subTask = tasks[i];

      if (result.status === "fulfilled") {
        subagentResults.push(result.value);
      } else {
        log.error("subagent failed entirely", {
          subTask: subTask.id,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        subagentResults.push({
          subTask,
          success: false,
          usedModelRouting: subTask.suggested_model_routing,
          content: "",
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          durationMs: 0,
        });
      }
    }

    log.info("subagent execution complete", {
      total: subagentResults.length,
      succeeded: subagentResults.filter((r) => r.success).length,
      failed: subagentResults.filter((r) => !r.success).length,
    });

    return subagentResults;
  }

  /**
   * Execute a single sub-task with retry logic.
   *
   * Runs the subagent as a STREAMING completion with no tools. Output/reasoning
   * is summarized live (via onSegment). If the upstream still emits tool calls,
   * they are treated as invalid output and the attempt is retried with a firmer
   * plain-text nudge instead of being executed or fed back as tool results.
   */
  private async executeSingle(
    ctx: FusionRequestContext,
    subTask: SubTask,
    options: {
      onGoalpost?: (event: GoalpostEvent) => void;
      onSegment?: (segment: SummarySegment) => void;
      signal?: AbortSignal;
    },
  ): Promise<SubagentResult> {
    const modelRouting = subTask.suggested_model_routing;
    const startTime = performance.now();
    const subagentRunId = ctx.fusionRunId
      ? makeFusionSubagentRunId(ctx.fusionRunId, subTask.id)
      : undefined;

    log.info("starting subagent", { subTask: subTask.id, modelRouting, focus: subTask.focus_area });
    this.startRun(ctx, subTask, modelRouting, subagentRunId);
    emitFusion(ctx, {
      type: "fusion.subagent",
      at: nowIso(),
      id: subTask.id,
      focus: subTask.focus_area,
      model: modelRouting,
      status: "started",
    });

    let lastError: string | undefined;
    let allContent = "";
    let attempts = 0;
    let nudgeNoTools = false;
    let lastBudget: SubagentContextBudget | undefined;
    let lastMessagePack: SubagentMessagePack | undefined;

    for (let attempt = 1; attempt <= MAX_SUBAGENT_RETRIES; attempt++) {
      attempts = attempt;
      try {
        const budget = this.subagentContextBudget(ctx, modelRouting);
        const messagePack = this.buildSubagentMessages(ctx, subTask, modelRouting, budget, attempt, nudgeNoTools);
        lastBudget = budget;
        lastMessagePack = messagePack;
        emitFusion(ctx, {
          type: "fusion.subagent",
          at: nowIso(),
          id: subTask.id,
          focus: subTask.focus_area,
          model: modelRouting,
          status: "progress",
          attempt,
          detail: {
            stage: "context_pack",
            contextWindow: budget.contextWindow,
            inputBudgetTokens: budget.inputBudgetTokens,
            outputBudgetTokens: budget.outputBudgetTokens,
            contextMessageCount: messagePack.contextMessageCount,
            droppedMessageCount: messagePack.droppedMessageCount,
            packedContextTokens: messagePack.packedContextTokens,
          },
        });
        const attemptSignal = this.createAttemptSignal(ctx, options);

        try {
          const streamed = await this.streamAttempt(ctx, subTask, {
            modelRouting,
            requestData: {
              model: modelRouting,
              messages: messagePack.messages,
              max_tokens: budget.outputBudgetTokens,
              stream: true,
              tool_choice: "none",
            },
            signal: attemptSignal.signal,
            onSegment: options.onSegment,
          });
          const content = stripToolCallArtifacts(streamed.content).trim();

          if (streamed.toolCalls.length > 0 && content.length === 0) {
            nudgeNoTools = true;
            throw new Error("subagent attempted tool calls despite receiving no tools; retrying with plain-text-only nudge");
          }
          if (content.length === 0) {
            nudgeNoTools = false;
            throw new Error("subagent produced empty content");
          }

          allContent += (allContent ? "\n\n" : "") + content;

          if (options.onGoalpost) {
            this.detectGoalposts(subTask, content, options.onGoalpost);
          }

          const durationMs = Math.round(performance.now() - startTime);
          log.info("subagent completed", {
            subTask: subTask.id,
            attempt,
            contentLength: content.length,
            contextWindow: budget.contextWindow,
            inputBudgetTokens: budget.inputBudgetTokens,
            outputBudgetTokens: budget.outputBudgetTokens,
            contextMessageCount: messagePack.contextMessageCount,
            droppedMessageCount: messagePack.droppedMessageCount,
            packedContextTokens: messagePack.packedContextTokens,
            durationMs,
          });
          this.finishRun(subagentRunId, "completed", attempts, durationMs, content);
          emitFusion(ctx, {
            type: "fusion.subagent",
            at: nowIso(),
            id: subTask.id,
            focus: subTask.focus_area,
            model: modelRouting,
            status: "completed",
            attempt,
            chars: content.length,
            durationMs,
            detail: {
              stage: "completed",
              contextWindow: budget.contextWindow,
              inputBudgetTokens: budget.inputBudgetTokens,
              outputBudgetTokens: budget.outputBudgetTokens,
              contextMessageCount: messagePack.contextMessageCount,
              droppedMessageCount: messagePack.droppedMessageCount,
              packedContextTokens: messagePack.packedContextTokens,
            },
          });

          return {
            subTask,
            success: true,
            usedModelRouting: modelRouting,
            subagentRunId,
            content,
            durationMs,
            contextWindow: budget.contextWindow,
            inputBudgetTokens: budget.inputBudgetTokens,
            outputBudgetTokens: budget.outputBudgetTokens,
            contextMessageCount: messagePack.contextMessageCount,
            droppedMessageCount: messagePack.droppedMessageCount,
            packedContextTokens: messagePack.packedContextTokens,
          };
        } finally {
          attemptSignal.cleanup();
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        if (attempt < MAX_SUBAGENT_RETRIES && this.shouldRetry(err, attempt)) {
          log.warn("subagent retrying", {
            subTask: subTask.id,
            attempt,
            error: lastError,
          });
          emitFusion(ctx, {
            type: "fusion.subagent",
            at: nowIso(),
            id: subTask.id,
            focus: subTask.focus_area,
            model: modelRouting,
            status: "retrying",
            attempt,
            error: lastError,
          });
          await this.sleep(RETRY_DELAY_MS * attempt);
          continue;
        }

        log.error("subagent failed", {
          subTask: subTask.id,
          attempt,
          error: lastError,
        });
        // Non-retryable (or budget-exhausted) failure — do NOT fall through
        // to another attempt.
        break;
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    this.finishRun(
      subagentRunId,
      allContent.length > 0 ? "completed" : "failed",
      attempts,
      durationMs,
      allContent,
      lastError,
    );
    emitFusion(ctx, {
      type: "fusion.subagent",
      at: nowIso(),
      id: subTask.id,
      focus: subTask.focus_area,
      model: modelRouting,
      status: allContent.length > 0 ? "completed" : "failed",
      attempt: attempts,
      chars: allContent.length,
      durationMs,
      error: lastError,
      detail: this.subagentTerminalDetail("failed", lastBudget, lastMessagePack),
    });
    return {
      subTask,
      success: allContent.length > 0,
      usedModelRouting: modelRouting,
      subagentRunId,
      content: allContent,
      error: lastError,
      durationMs,
      contextWindow: lastBudget?.contextWindow,
      inputBudgetTokens: lastBudget?.inputBudgetTokens,
      outputBudgetTokens: lastBudget?.outputBudgetTokens,
      contextMessageCount: lastMessagePack?.contextMessageCount,
      droppedMessageCount: lastMessagePack?.droppedMessageCount,
      packedContextTokens: lastMessagePack?.packedContextTokens,
    };
  }

  private subagentTerminalDetail(
    stage: "completed" | "failed",
    budget: SubagentContextBudget | undefined,
    messagePack: SubagentMessagePack | undefined,
  ): Record<string, unknown> | undefined {
    if (budget === undefined || messagePack === undefined) return undefined;
    return {
      stage,
      contextWindow: budget.contextWindow,
      inputBudgetTokens: budget.inputBudgetTokens,
      outputBudgetTokens: budget.outputBudgetTokens,
      contextMessageCount: messagePack.contextMessageCount,
      droppedMessageCount: messagePack.droppedMessageCount,
      packedContextTokens: messagePack.packedContextTokens,
    };
  }

  /**
   * Run one streaming subagent completion, accumulating content, structured
   * tool calls, and emitting live summary segments as raw output/reasoning
   * accumulates.
   */
  private async streamAttempt(
    ctx: FusionRequestContext,
    subTask: SubTask,
    args: {
      modelRouting: string;
      requestData: Record<string, unknown>;
      signal: AbortSignal | undefined;
      onSegment?: (segment: SummarySegment) => void;
    },
  ): Promise<{ content: string; toolCalls: AccumulatedToolCall[]; finishReason: string | undefined }> {
    const segmentChars = ctx.fusionConfig.summarizer.segment_chars;
    const label = `${subTask.id} · ${subTask.focus_area}`;
    let content = "";
    let unsummarized = "";
    let streamedChars = 0;
    let finishReason: string | undefined;
    const toolCallAcc = new Map<number, AccumulatedToolCall>();

    const emitSegmentText = (text: string) => {
      const sanitized = stripToolCallArtifacts(text);
      if (sanitized.trim().length === 0) return;
      args.onSegment?.({ label, text: sanitized });
      emitFusion(ctx, {
        type: "fusion.subagent",
        at: nowIso(),
        id: subTask.id,
        focus: subTask.focus_area,
        model: args.modelRouting,
        status: "progress",
        chars: streamedChars,
      });
    };

    const flushSegment = (force: boolean) => {
      if (args.onSegment === undefined) return;
      if (unsummarized.length === 0) return;

      if (force) {
        if (unsummarized.trim().length < MIN_FLUSH_SEGMENT_CHARS) {
          unsummarized = "";
          return;
        }
        emitSegmentText(unsummarized);
        unsummarized = "";
        return;
      }

      // Prefer flushing at paragraph boundaries so summaries track natural
      // units of thought instead of arbitrary cut points.
      if (unsummarized.length >= MIN_PARAGRAPH_FLUSH_CHARS) {
        const boundary = unsummarized.lastIndexOf("\n\n");
        if (boundary >= MIN_FLUSH_SEGMENT_CHARS) {
          emitSegmentText(unsummarized.slice(0, boundary));
          unsummarized = unsummarized.slice(boundary + 2);
          return;
        }
      }
      if (unsummarized.length >= segmentChars) {
        emitSegmentText(unsummarized);
        unsummarized = "";
      }
    };

    const streamGen = this.fallbackRouter.streamWithFallback({
      logicalModel: args.modelRouting,
      requestData: args.requestData,
      targetProtocol: "openai",
      signal: args.signal,
      principal: ctx.principal,
      extraHeaders: ctx.extraHeaders,
    });

    for await (const raw of streamGen) {
      for (const event of splitSseEvents(raw)) {
        const parsed = parseOpenAIDelta(event);
        if (parsed === null) continue;
        if (parsed.hasToolCalls) {
          mergeToolCallDeltas(toolCallAcc, parsed.toolCallDeltas);
        }
        if (parsed.finishReason !== undefined) {
          finishReason = parsed.finishReason;
        }
        if (parsed.content.length > 0) {
          content += parsed.content;
          unsummarized += parsed.content;
          streamedChars += parsed.content.length;
        }
        if (parsed.reasoning.length > 0) {
          unsummarized += parsed.reasoning;
          streamedChars += parsed.reasoning.length;
        }
        flushSegment(false);
      }
    }
    flushSegment(true);

    const toolCalls = [...toolCallAcc.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => call)
      .filter((call) => call.name.length > 0);

    return { content, toolCalls, finishReason };
  }

  private resolveExecutableTasks(ctx: FusionRequestContext, subTasks: SubTask[]): SubTask[] {
    const runtimeEffort = ctx.runtimeEffort ?? 2;
    const effortConfig = runtimeEffort === 3
      ? ctx.fusionConfig.effort_levels[3]
      : ctx.fusionConfig.effort_levels[2];
    const allowedModels = effortConfig?.model_routings ?? [ctx.fusionConfig.task_divider.model_routing];
    const minCount = effortConfig?.subagent_count.min ?? 1;
    const maxCount = Math.min(effortConfig?.subagent_count.max ?? 8, ctx.execution?.remainingLeafCalls ?? 8, 8);
    const normalized = subTasks.map((task, index) => {
      const candidate = allowedModels.includes(task.suggested_model_routing)
        ? task.suggested_model_routing
        : allowedModels[index % allowedModels.length]!;
      return {
        ...task,
        suggested_model_routing: this.resolveNestedSafeModel(ctx, candidate, allowedModels, index),
      };
    }).slice(0, maxCount);

    while (normalized.length < Math.min(minCount, maxCount)) {
      const index = normalized.length + 1;
      normalized.push({
        id: `policy-fill-${index}`,
        description: "Review the full request and provide any important analysis not covered by the other Fusion subtasks.",
        focus_area: "general",
        suggested_model_routing: allowedModels[(index - 1) % allowedModels.length]!,
      });
    }

    return normalized;
  }

  private resolveNestedSafeModel(
    ctx: FusionRequestContext,
    candidate: string,
    allowedModels: string[],
    index: number,
  ): string {
    if (!this.isFusionModel(candidate)) return candidate;
    const execution = ctx.execution;
    const nestedAllowed =
      execution?.allowNestedFusion === true &&
      execution.depth < execution.maxDepth &&
      execution.remainingLeafCalls > 1;
    if (nestedAllowed) return candidate;
    const replacement = allowedModels.find((model) => model !== candidate && !this.isFusionModel(model));
    if (replacement !== undefined) {
      log.info("downgrading nested fusion subagent route", { candidate, replacement, index });
      return replacement;
    }
    log.warn("nested fusion subagent route blocked without non-fusion replacement", { candidate, index });
    return ctx.fusionConfig.task_divider.model_routing;
  }

  private isFusionModel(logicalModel: string): boolean {
    try {
      return modelConfigLoader.loadConfig(logicalModel).fusion?.enabled === true;
    } catch {
      return false;
    }
  }

  private createAttemptSignal(
    ctx: FusionRequestContext,
    options: { signal?: AbortSignal },
  ): { signal: AbortSignal | undefined; cleanup: () => void } {
    const timeoutMs = ctx.fusionConfig.task_divider.timeout_seconds * 1000;
    const baseSignal = options.signal ?? ctx.signal;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return { signal: baseSignal, cleanup: () => undefined };
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(abort, timeoutMs);
    if (baseSignal !== undefined) {
      if (baseSignal.aborted) {
        controller.abort();
      } else {
        baseSignal.addEventListener("abort", abort, { once: true });
      }
    }
    return {
      signal: controller.signal,
      cleanup: () => {
        clearTimeout(timeout);
        baseSignal?.removeEventListener("abort", abort);
      },
    };
  }

  /**
   * Build messages for a subagent with full context passthrough.
   *
   * The system prompt is deliberately exhaustive about the subagent's sealed
   * environment: these models see a transcript full of real tool calls made
   * by the client's harness and will otherwise convince themselves they can
   * (or already did) act on the environment.
   */
  private buildSubagentMessages(
    ctx: FusionRequestContext,
    subTask: SubTask,
    modelRouting: string,
    budget: SubagentContextBudget,
    attempt: number,
    nudgeNoTools = false,
  ): SubagentMessagePack {
    const systemPrompt = {
      role: "system",
      content: `You are an isolated RESEARCH AND REASONING subagent inside a multi-model fusion pipeline.

Your focus area: ${subTask.focus_area}
Your sub-task: ${subTask.description}

UNDERSTAND YOUR ENVIRONMENT — this is critical:
- You run in a sealed analysis sandbox. You CANNOT create, edit, delete, or run anything in the user's environment. You have no filesystem access, no terminal, no git, no deploy powers, and no connection to the user's machine.
- The conversation transcript below may show tools like file editors, shells, or task runners being used. Those belong to a SEPARATE agent harness that you are not part of and cannot invoke. Any attempt to call them will fail.
- You have NO tools in this environment. No function-calling tools are available to you, including search, web, code execution, shells, editors, or project readers. The Fusion proxy has already triaged context for you below.
- You are NOT the primary assistant and the user will never see your words directly. A separate final "fusion" synthesis model reads your analysis and is the ONLY entity that produces the user-facing response and performs real actions (file edits, real tool calls, commands).

RULES FOR YOUR OUTPUT:
- NEVER claim to have created, modified, executed, or deployed anything. You physically cannot.
- NEVER write tool-call syntax, tool-call JSON, or pseudo-invocations in your text. There is no tool-calling interface for you. Everything must be plain prose and code snippets meant as recommendations.
- Do NOT address the end user directly and do not roleplay as the primary assistant.

YOUR ACTUAL JOB:
Study the context briefing and conversation slices below to understand the complete picture, then produce deep, specific research and reasoning for your assigned focus area: findings, root-cause analysis, edge cases, trade-offs, and concrete recommendations (exact code snippets, step-by-step guidance, precise file/function references) that the fusion model can act on.

Be thorough and complete — do not truncate or trim your analysis.`,
    };

    const systemTokens = estimateTokens(JSON.stringify(systemPrompt));
    const taskPromptTokens = estimateTokens(JSON.stringify({
      role: "user",
      content: `Please complete the following sub-task: ${subTask.description}\n\nFocus area: ${subTask.focus_area}`,
    }));
    const contextBudget = Math.max(
      MIN_SUBAGENT_INPUT_TOKENS,
      budget.inputBudgetTokens - systemTokens - taskPromptTokens,
    );
    const { contextMessages, briefing, estimatedTokens, droppedMessages } =
      this.buildAdaptiveContextPack(ctx, subTask, contextBudget);

    const nudge = nudgeNoTools
      ? " REMINDER: you have no tools. Do not call or describe tool calls. Write your full analysis and recommendations as plain text for the fusion model."
      : "";
    const focusedMessages = [
      systemPrompt,
      {
        role: "user",
        content: briefing,
      },
      ...contextMessages,
      {
        role: "user",
        content: attempt > 1
          ? `[Retry ${attempt}] Focus specifically on: ${subTask.description} in the area of ${subTask.focus_area}. Provide a complete and thorough research/reasoning response as plain text.${nudge}`
          : `Please analyze the following sub-task and produce your research/reasoning output: ${subTask.description}\n\nFocus area: ${subTask.focus_area}${nudge}`,
      },
    ];

    log.info("subagent context built", {
      subTask: subTask.id,
      modelRouting,
      modelContextWindow: budget.contextWindow,
      inputBudgetTokens: budget.inputBudgetTokens,
      outputBudgetTokens: budget.outputBudgetTokens,
      totalMessages: focusedMessages.length,
      contextMessages: contextMessages.length,
      estimatedTokens,
      droppedMessages,
    });

    return {
      messages: focusedMessages,
      contextMessageCount: contextMessages.length,
      droppedMessageCount: droppedMessages,
      packedContextTokens: estimatedTokens,
    };
  }

  private subagentContextBudget(ctx: FusionRequestContext, modelRouting: string): SubagentContextBudget {
    const contextWindow = Math.max(
      4096,
      Math.min(ctx.fusionConfig.context_window, this.resolveDeclaredContextWindow(modelRouting)),
    );
    const outputReserve = Math.min(
      DEFAULT_MAX_OUTPUT_TOKENS,
      Math.max(1024, Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO)),
    );
    const inputBudgetTokens = Math.max(
      MIN_SUBAGENT_INPUT_TOKENS,
      contextWindow - outputReserve,
    );
    return {
      contextWindow,
      inputBudgetTokens,
      outputBudgetTokens: outputReserve,
    };
  }

  private resolveDeclaredContextWindow(modelRouting: string): number {
    try {
      const cfg = modelConfigLoader.loadConfig(modelRouting);
      const primary = cfg.model_routings[0];
      return primary?.context_window ?? cfg.context_window ?? SYSTEM_DEFAULT_CONTEXT_WINDOW;
    } catch {
      return SYSTEM_DEFAULT_CONTEXT_WINDOW;
    }
  }

  private buildAdaptiveContextPack(
    ctx: FusionRequestContext,
    subTask: SubTask,
    tokenBudget: number,
  ): {
    contextMessages: unknown[];
    briefing: string;
    estimatedTokens: number;
    droppedMessages: number;
  } {
    const sanitized = ctx.messages.map((msg) => this.sanitizeContextMessage(msg));
    const taskTerms = `${subTask.focus_area} ${subTask.description}`;
    const firstCount = Math.min(3, sanitized.length);
    const recentTarget = Math.min(80, Math.max(20, Math.floor(tokenBudget / 1600)));
    const relevantTarget = Math.min(24, Math.max(6, Math.floor(tokenBudget / 6000)));
    const anchorTarget = Math.min(24, Math.max(4, Math.floor(tokenBudget / 8000)));
    const relevantHits = this.scoreMessages(sanitized, taskTerms).slice(0, relevantTarget);
    const selectedIndexes = new Set<number>();

    for (let i = 0; i < firstCount; i++) selectedIndexes.add(i);
    for (const hit of relevantHits) selectedIndexes.add(hit.index);
    for (const index of this.sampleMiddleIndexes(sanitized.length, firstCount, recentTarget, anchorTarget)) {
      selectedIndexes.add(index);
    }
    for (let i = Math.max(firstCount, sanitized.length - recentTarget); i < sanitized.length; i++) {
      selectedIndexes.add(i);
    }

    let contextMessages = [...selectedIndexes]
      .sort((a, b) => a - b)
      .map((index) => sanitized[index])
      .filter((message): message is unknown => message !== undefined);
    if (contextMessages.length > MAX_CONTEXT_MESSAGES) {
      contextMessages = contextMessages.slice(contextMessages.length - MAX_CONTEXT_MESSAGES);
    }

    const relevantExcerpt = this.keywordContextBrief(relevantHits);
    let droppedMessages = Math.max(0, sanitized.length - contextMessages.length);
    let briefing = this.buildContextBriefing({
      logicalContextWindow: ctx.fusionConfig.context_window,
      tokenBudget,
      suppliedMessages: contextMessages.length,
      totalMessages: sanitized.length,
      firstCount,
      relevantTarget,
      anchorTarget,
      recentTarget,
      droppedMessages,
      relevantExcerpt,
    });
    let estimatedTokens = this.estimateContextPacketTokens(contextMessages, briefing);

    while (estimatedTokens > tokenBudget && contextMessages.length > 1) {
      const firstProtected = contextMessages.length > 4 ? 1 : 0;
      const removeAt = firstProtected + Math.floor((contextMessages.length - firstProtected) / 2);
      contextMessages.splice(removeAt, 1);
      droppedMessages = Math.max(0, sanitized.length - contextMessages.length);
      briefing = this.buildContextBriefing({
        logicalContextWindow: ctx.fusionConfig.context_window,
        tokenBudget,
        suppliedMessages: contextMessages.length,
        totalMessages: sanitized.length,
        firstCount,
        relevantTarget,
        anchorTarget,
        recentTarget,
        droppedMessages,
        relevantExcerpt,
      });
      estimatedTokens = this.estimateContextPacketTokens(contextMessages, briefing);
    }

    if (estimatedTokens > tokenBudget && contextMessages.length > 0) {
      contextMessages = this.truncateOversizedContextMessages(contextMessages, Math.max(0, tokenBudget - estimateTokens(briefing)));
      estimatedTokens = this.estimateContextPacketTokens(contextMessages, briefing);
    }

    return { contextMessages, briefing, estimatedTokens, droppedMessages };
  }

  private buildContextBriefing(args: {
    logicalContextWindow: number;
    tokenBudget: number;
    suppliedMessages: number;
    totalMessages: number;
    firstCount: number;
    relevantTarget: number;
    anchorTarget: number;
    recentTarget: number;
    droppedMessages: number;
    relevantExcerpt: string;
  }): string {
    return [
      "Fusion proxy context briefing for this subagent:",
      `- Logical Fusion context window: ${args.logicalContextWindow} tokens.`,
      `- Your routed model context budget is smaller/adaptive; this packet targets about ${args.tokenBudget} input tokens.`,
      `- Conversation messages supplied verbatim: ${args.suppliedMessages}/${args.totalMessages}.`,
      `- Stratified context mix before final budget pruning: first=${args.firstCount}, relevant<=${args.relevantTarget}, middle_anchors<=${args.anchorTarget}, recent<=${args.recentTarget}.`,
      args.droppedMessages > 0
        ? `- ${args.droppedMessages} older or lower-priority messages were omitted to preserve room for reasoning.`
        : "- No messages were omitted from this context packet.",
      "- Relevant excerpts selected by the proxy before your call:",
      args.relevantExcerpt,
      "",
      "Use only the supplied briefing and message slices. If something is missing, state the uncertainty and recommend what the fusion model should inspect next.",
    ].join("\n");
  }

  private estimateContextPacketTokens(contextMessages: unknown[], briefing: string): number {
    return estimateMessageTokens([
      { role: "user", content: briefing },
      ...contextMessages,
    ]);
  }

  private truncateOversizedContextMessages(messages: unknown[], tokenBudget: number): unknown[] {
    if (messages.length === 0 || tokenBudget <= 0) return [];
    const perMessageTokens = Math.max(256, Math.floor(tokenBudget / messages.length));
    const maxContentChars = Math.max(512, perMessageTokens * 4);
    return messages.map((message) => this.truncateContextMessage(message, maxContentChars));
  }

  private truncateContextMessage(message: unknown, maxContentChars: number): unknown {
    const msg = message as Record<string, unknown>;
    const content = msg["content"];
    if (typeof content === "string") {
      if (content.length <= maxContentChars) return message;
      return {
        ...msg,
        content: this.truncateMiddleText(content, maxContentChars, "context message truncated to fit subagent route budget"),
      };
    }
    const serialized = JSON.stringify(content ?? "");
    if (serialized.length <= maxContentChars) return message;
    return {
      ...msg,
      content: this.truncateMiddleText(serialized, maxContentChars, "context message truncated to fit subagent route budget"),
    };
  }

  private truncateMiddleText(text: string, maxChars: number, note: string): string {
    const marker = `\n[${note}; omitted middle]\n`;
    const available = Math.max(0, maxChars - marker.length);
    if (available <= 0) return marker.trim();
    const headChars = Math.max(1, Math.floor(available * 0.65));
    const tailChars = Math.max(1, available - headChars);
    const head = text.slice(0, headChars).replace(/\s+\S*$/, "").trimEnd();
    const tail = text.slice(text.length - tailChars).replace(/^\S*\s+/, "").trimStart();
    return `${head}${marker}${tail}`;
  }

  private scoreMessages(messages: unknown[], query: string): Array<{ index: number; role: string; text: string; score: number }> {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 3);
    if (terms.length === 0) return [];

    const hits: Array<{ index: number; role: string; text: string; score: number }> = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as Record<string, unknown>;
      const text = this.messageText(msg);
      const lower = text.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (score > 0) {
        hits.push({ index: i, role: String(msg["role"] ?? "unknown"), text, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  private sampleMiddleIndexes(
    messageCount: number,
    firstCount: number,
    recentTarget: number,
    anchorTarget: number,
  ): number[] {
    const middleStart = firstCount;
    const middleEndExclusive = Math.max(middleStart, messageCount - recentTarget);
    const middleCount = middleEndExclusive - middleStart;
    if (middleCount <= 0 || anchorTarget <= 0) return [];
    const count = Math.min(anchorTarget, middleCount);
    const indexes: number[] = [];
    for (let i = 1; i <= count; i++) {
      indexes.push(middleStart + Math.floor((i * middleCount) / (count + 1)));
    }
    return indexes;
  }

  private keywordContextBrief(hits: Array<{ index: number; role: string; text: string; score: number }>): string {
    if (hits.length === 0) return "No context slices directly matched the sub-task focus keywords.";

    return hits
      .slice(0, 8)
      .map((hit) => {
        const excerpt = hit.text.length > 800 ? `${hit.text.slice(0, 800)}\n[excerpt truncated]` : hit.text;
        return `[message ${hit.index + 1}, role=${hit.role}, score=${hit.score}]\n${excerpt}`;
      })
      .join("\n\n");
  }

  private sanitizeContextMessage(msg: unknown): unknown {
    const m = msg as Record<string, unknown>;
    const content = m["content"];
    if (!Array.isArray(content)) return msg;
    return {
      ...m,
      content: content.map((part) => {
        const p = part as Record<string, unknown>;
        if (p["type"] === "image_url") return { type: "text", text: "[Image]" };
        return part;
      }),
    };
  }

  private messageText(msg: Record<string, unknown>): string {
    const content = msg["content"];
    return typeof content === "string" ? content : JSON.stringify(content ?? "");
  }

  private detectGoalposts(
    subTask: SubTask,
    content: string,
    onGoalpost: (event: GoalpostEvent) => void,
  ): void {
    for (const gp of GOALPOST_PATTERNS) {
      if (gp.pattern.test(content)) {
        onGoalpost({
          type: gp.type,
          subagentId: subTask.id,
          transcriptPortion: content.slice(-500),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private shouldRetry(err: unknown, attempt: number): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();
    const nonRetryable = [
      "invalid_request_error",
      "invalid_api_key",
      "insufficient_quota",
      "context_length_exceeded",
    ];
    for (const pattern of nonRetryable) {
      if (lower.includes(pattern)) return false;
    }
    // Timeout-style aborts consumed the full attempt budget already; a
    // second identical timeout would stall the whole pipeline for minutes.
    // Allow exactly one retry for aborts, then fail fast.
    if (lower.includes("abort") && attempt >= 2) return false;
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private startRun(
    ctx: FusionRequestContext,
    subTask: SubTask,
    modelRouting: string,
    subagentRunId: string | undefined,
  ): void {
    if (!subagentRunId || !ctx.fusionRunId) return;
    try {
      startFusionSubagentRun({
        subagentRunId,
        fusionRunId: ctx.fusionRunId,
        parentRunId: ctx.execution?.parentRunId,
        subtaskId: subTask.id,
        focusArea: subTask.focus_area,
        descriptionHash: hashFusionValue(subTask.description),
        modelRouting,
        metadata: { depth: ctx.execution?.depth ?? 0 },
      });
    } catch (err) {
      log.warn("failed to start fusion subagent run", { subagentRunId, error: String(err) });
    }
  }

  private finishRun(
    subagentRunId: string | undefined,
    status: "completed" | "failed",
    attemptCount: number,
    durationMs: number,
    content: string,
    error?: string,
  ): void {
    if (!subagentRunId) return;
    try {
      finishFusionSubagentRun({
        subagentRunId,
        status,
        attemptCount,
        durationMs,
        outputHash: content ? hashFusionValue(content) : undefined,
        metadata: error ? { error } : undefined,
      });
    } catch (err) {
      log.warn("failed to finish fusion subagent run", { subagentRunId, error: String(err) });
    }
  }
}
