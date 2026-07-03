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
import { ResearchToolbox } from "./subagent-tools.ts";
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

/** Maximum research-tool rounds within a single attempt. */
const MAX_TOOL_ROUNDS = 5;

/** Delay between retries (ms). */
const RETRY_DELAY_MS = 500;

/** Default max output tokens for subagents — large enough for 1M-context models. */
const DEFAULT_MAX_OUTPUT_TOKENS = 131072;

/** Max input messages to include (safety ceiling). */
const MAX_CONTEXT_MESSAGES = 200;

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

/** Render a research tool invocation as plain prose for the summarizer. */
function describeToolUse(name: string, argumentsJson: string): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
  } catch { /* fall back to generic description */ }
  switch (name) {
    case "search_context":
      return `Searching the conversation context for "${String(args["query"] ?? "").slice(0, 120)}".`;
    case "web_search":
      return `Searching the web for "${String(args["query"] ?? "").slice(0, 120)}".`;
    case "fetch_url":
      return `Reading the page at ${String(args["url"] ?? "").slice(0, 160)}.`;
    case "execute_code":
      return `Running a ${String(args["language"] ?? "code")} snippet in the research sandbox to verify the reasoning.`;
    default:
      return `Using the ${name} research tool.`;
  }
}

// ── Streaming tool-call accumulation ──────────────────────────────────

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
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
 *  - A research-only tool loop (context search, web search, sandboxed code
 *    execution — per effort-level config) executed locally by the proxy
 *
 * Subagents are research/reasoning-only. Their tools are informational and
 * sandboxed; they can NEVER touch the client's environment. Their output is
 * advisory input for the final fusion model, which is the only entity that
 * produces user-facing responses and real tool calls.
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

    const toolbox = new ResearchToolbox(ctx.messages, this.enabledToolIds(ctx));
    log.info("executing subagents", { count: tasks.length, tools: toolbox.toolNames });

    const results = await Promise.allSettled(
      tasks.map((subTask) => this.executeSingle(ctx, subTask, toolbox, options)),
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

  /** Tool IDs enabled by the active effort-level config. */
  private enabledToolIds(ctx: FusionRequestContext): readonly string[] {
    const runtimeEffort = ctx.runtimeEffort ?? 2;
    const effortConfig = runtimeEffort === 3
      ? ctx.fusionConfig.effort_levels[3]
      : ctx.fusionConfig.effort_levels[2];
    return effortConfig?.tools ?? ["context_search"];
  }

  /**
   * Execute a single sub-task with retry logic.
   *
   * Runs the subagent as a STREAMING completion with a local research-tool
   * loop, so its output/reasoning can be summarized live (via onSegment)
   * while it works. Hallucinated tool calls (tools it saw in the transcript
   * but does not have) are answered with a firm correction and the loop
   * continues; genuine research tools are executed by the proxy.
   */
  private async executeSingle(
    ctx: FusionRequestContext,
    subTask: SubTask,
    toolbox: ResearchToolbox,
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

    for (let attempt = 1; attempt <= MAX_SUBAGENT_RETRIES; attempt++) {
      attempts = attempt;
      try {
        const subagentMessages = this.buildSubagentMessages(ctx, subTask, toolbox, attempt, nudgeNoTools);
        const attemptSignal = this.createAttemptSignal(ctx, options);

        try {
          const attemptResult = await this.runToolLoop(ctx, subTask, {
            modelRouting,
            messages: subagentMessages,
            toolbox,
            signal: attemptSignal.signal,
            onSegment: options.onSegment,
          });

          if (attemptResult.sawUnavailableTools && attemptResult.content.trim().length === 0) {
            nudgeNoTools = true;
            throw new Error("subagent kept attempting unavailable tools without producing analysis; retrying with research-only nudge");
          }
          if (attemptResult.content.trim().length === 0) {
            nudgeNoTools = false;
            throw new Error("subagent produced empty content");
          }

          const content = attemptResult.content;
          allContent += (allContent ? "\n\n" : "") + content;

          if (options.onGoalpost) {
            this.detectGoalposts(subTask, content, options.onGoalpost);
          }

          const durationMs = Math.round(performance.now() - startTime);
          log.info("subagent completed", {
            subTask: subTask.id,
            attempt,
            contentLength: content.length,
            toolRounds: attemptResult.toolRounds,
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
          });

          return {
            subTask,
            success: true,
            usedModelRouting: modelRouting,
            subagentRunId,
            content,
            durationMs,
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
    });
    return {
      subTask,
      success: allContent.length > 0,
      usedModelRouting: modelRouting,
      subagentRunId,
      content: allContent,
      error: lastError,
      durationMs,
    };
  }

  /**
   * Run one attempt as an agentic research loop: stream a completion, and if
   * the subagent invokes research tools, execute them locally, append results,
   * and continue until it produces its final written analysis.
   */
  private async runToolLoop(
    ctx: FusionRequestContext,
    subTask: SubTask,
    args: {
      modelRouting: string;
      messages: unknown[];
      toolbox: ResearchToolbox;
      signal: AbortSignal | undefined;
      onSegment?: (segment: SummarySegment) => void;
    },
  ): Promise<{ content: string; toolRounds: number; sawUnavailableTools: boolean }> {
    const workingMessages = [...args.messages];
    const toolSchemas = args.toolbox.schemas;
    let combinedContent = "";
    let sawUnavailableTools = false;
    let roundsUsed = 0;

    for (let round = 1; round <= MAX_TOOL_ROUNDS; round++) {
      roundsUsed = round;
      const request: Record<string, unknown> = {
        model: args.modelRouting,
        messages: workingMessages,
        max_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
        stream: true,
      };
      if (toolSchemas.length > 0) {
        request["tools"] = toolSchemas;
        request["tool_choice"] = "auto";
      }

      const streamed = await this.streamAttempt(ctx, subTask, {
        modelRouting: args.modelRouting,
        requestData: request,
        signal: args.signal,
        onSegment: args.onSegment,
      });

      const cleanContent = stripToolCallArtifacts(streamed.content).trim();
      if (cleanContent.length > 0) {
        combinedContent += (combinedContent ? "\n\n" : "") + cleanContent;
      }

      if (streamed.toolCalls.length === 0) {
        break;
      }

      // The subagent asked for tools. Execute research tools locally;
      // firmly correct hallucinated (unavailable) tools.
      const assistantToolCalls = streamed.toolCalls.map((tc, i) => ({
        id: tc.id || `${subTask.id}-tool-${round}-${i + 1}`,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments || "{}" },
      }));
      workingMessages.push({
        role: "assistant",
        content: streamed.content.length > 0 ? streamed.content : null,
        tool_calls: assistantToolCalls,
      });

      for (const call of assistantToolCalls) {
        const name = call.function.name;
        let result: string;
        if (args.toolbox.has(name)) {
          const toolStart = performance.now();
          result = await args.toolbox.execute(name, call.function.arguments);
          const toolMs = Math.round(performance.now() - toolStart);
          log.info("subagent research tool executed", {
            subTask: subTask.id,
            tool: name,
            round,
            durationMs: toolMs,
            resultChars: result.length,
          });
          emitFusion(ctx, {
            type: "fusion.subagent",
            at: nowIso(),
            id: subTask.id,
            focus: subTask.focus_area,
            model: args.modelRouting,
            status: "progress",
            detail: { tool: name, round, durationMs: toolMs },
          });
          // Surface tool activity on the live reasoning channel via the
          // summarizer, so the client sees "searched the web for X" style
          // narration instead of silence during research.
          args.onSegment?.({
            label: `${subTask.id} · ${subTask.focus_area}`,
            text: `${describeToolUse(name, call.function.arguments)}\n\nKey findings from the tool:\n${result.slice(0, 700)}`,
          });
        } else {
          sawUnavailableTools = true;
          result = args.toolbox.unavailableToolMessage(name);
          log.info("subagent hallucinated unavailable tool; corrected", {
            subTask: subTask.id,
            tool: name,
            round,
          });
        }
        workingMessages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: result,
        });
      }

      if (round === MAX_TOOL_ROUNDS) {
        log.warn("subagent hit tool-round limit", { subTask: subTask.id });
        break;
      }
      // Ask for the final written analysis after tool budget is half spent.
      if (round >= Math.ceil(MAX_TOOL_ROUNDS / 2)) {
        workingMessages.push({
          role: "user",
          content:
            "Wrap up your research now. Write your complete final analysis for your assigned focus area as plain text — findings, reasoning, and concrete recommendations. Do not call any more tools.",
        });
      }
    }

    return { content: combinedContent, toolRounds: roundsUsed, sawUnavailableTools };
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
    toolbox: ResearchToolbox,
    attempt: number,
    nudgeNoTools = false,
  ): unknown[] {
    const { messages } = ctx;

    const toolNames = toolbox.toolNames;
    const toolsSection = toolNames.length > 0
      ? `RESEARCH TOOLS — the ONLY tools that exist for you:
${toolNames.map((name) => `- ${name}`).join("\n")}
These tools are informational and sandboxed. They search, fetch, and compute in an isolated scratch environment run by the pipeline itself. They CANNOT touch the user's project, filesystem, git state, running services, or anything else outside the sandbox. Use them to strengthen your research, then write your analysis.`
      : `You have NO tools at all in this environment.`;

    const systemPrompt = {
      role: "system",
      content: `You are an isolated RESEARCH AND REASONING subagent inside a multi-model fusion pipeline.

Your focus area: ${subTask.focus_area}
Your sub-task: ${subTask.description}

UNDERSTAND YOUR ENVIRONMENT — this is critical:
- You run in a sealed analysis sandbox. You CANNOT create, edit, delete, or run anything in the user's environment. You have no filesystem access, no terminal, no git, no deploy powers, and no connection to the user's machine.
- The conversation transcript below may show tools like file editors, shells, or task runners being used. Those belong to a SEPARATE agent harness that you are not part of and cannot invoke. Any attempt to call them will fail.
- ${toolsSection}
- You are NOT the primary assistant and the user will never see your words directly. A separate final "fusion" synthesis model reads your analysis and is the ONLY entity that produces the user-facing response and performs real actions (file edits, real tool calls, commands).

RULES FOR YOUR OUTPUT:
- NEVER claim to have created, modified, executed, or deployed anything. You physically cannot.
- NEVER write tool-call syntax, tool-call JSON, or pseudo-invocations in your text. If you need a research tool, invoke it properly through the tool-calling interface; everything else must be plain prose and code snippets meant as recommendations.
- Do NOT address the end user directly and do not roleplay as the primary assistant.

YOUR ACTUAL JOB:
Study the FULL conversation context below to understand the complete picture, then produce deep, specific research and reasoning for your assigned focus area: findings, root-cause analysis, edge cases, trade-offs, and concrete recommendations (exact code snippets, step-by-step guidance, precise file/function references) that the fusion model can act on.

Be thorough and complete — do not truncate or trim your analysis.`,
    };

    // Build context messages - include as many as possible
    // Strategy: include ALL messages first, then trim oldest if over budget
    const systemTokens = estimateTokens(JSON.stringify(systemPrompt));
    const availableTokens = 900_000; // Leave headroom for output (131K)
    let contextMessages = [...messages];

    // Sanitize image_url parts (already processed by preprocessor, but safety guard)
    contextMessages = contextMessages.map((msg) => {
      const m = msg as Record<string, unknown>;
      const content = m["content"];
      if (Array.isArray(content)) {
        return {
          ...m,
          content: content.map((part) => {
            const p = part as Record<string, unknown>;
            if (p["type"] === "image_url") {
              return { type: "text", text: "[Image]" };
            }
            return part;
          }),
        };
      }
      return msg;
    });

    // Token-aware truncation: drop oldest messages if context exceeds available budget
    const taskPromptTokens = estimateTokens(JSON.stringify({
      role: "user",
      content: `Please complete the following sub-task: ${subTask.description}\n\nFocus area: ${subTask.focus_area}`,
    }));

    let totalTokens = systemTokens + taskPromptTokens + estimateMessageTokens(contextMessages);
    const maxTries = 5;
    let tries = 0;

    while (totalTokens > availableTokens && contextMessages.length > 1 && tries < maxTries) {
      // Drop the oldest non-system message
      contextMessages.shift();
      totalTokens = systemTokens + taskPromptTokens + estimateMessageTokens(contextMessages);
      tries++;
    }

    // Further cap total message count to safety limit
    if (contextMessages.length > MAX_CONTEXT_MESSAGES) {
      // Drop from the middle first to keep conversation start + most recent
      const keepCount = MAX_CONTEXT_MESSAGES;
      const dropCount = contextMessages.length - keepCount;
      contextMessages = [
        ...contextMessages.slice(0, Math.min(5, dropCount)), // Keep first few for context
        ...contextMessages.slice(dropCount), // Keep the rest (most recent)
      ];
      // If still too many, just keep the most recent
      if (contextMessages.length > MAX_CONTEXT_MESSAGES) {
        contextMessages = contextMessages.slice(contextMessages.length - MAX_CONTEXT_MESSAGES);
      }
    }

    const nudge = nudgeNoTools
      ? " REMINDER: the harness tools in the transcript do NOT exist for you and calling them will fail — use only your listed research tools (if any), and write your full analysis and recommendations as plain text for the fusion model."
      : "";
    const focusedMessages = [
      systemPrompt,
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
      totalMessages: focusedMessages.length,
      contextMessages: contextMessages.length,
      estimatedTokens: totalTokens,
    });

    return focusedMessages;
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
