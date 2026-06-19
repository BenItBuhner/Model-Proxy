import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../fallback.ts";
import type { FusionRequestContext, SubTask, SubagentResult, GoalpostEvent } from "./types.ts";

const log = createLogger("routing.fusion.subagent");

/**
 * Maximum retries per subagent before giving up.
 */
const MAX_SUBAGENT_RETRIES = 3;

/**
 * Delay between retries (ms).
 */
const RETRY_DELAY_MS = 500;

// ── Goalpost patterns ─────────────────────────────────────────────────

/**
 * Patterns in subagent responses that trigger goalpost events.
 */
const GOALPOST_PATTERNS = [
  { type: "tool_call", pattern: /function|tool_use|tool_call/i },
  { type: "assistant_response", pattern: /therefore|in conclusion|to summarize|here('s| is) (the|my)/i },
  { type: "reasoning_step", pattern: /step \d|firstly|secondly|finally|next,|now, |let me/i },
  { type: "decision", pattern: /i (will|should|recommend|choose|decide)/i },
  { type: "finding", pattern: /found|identified|discovered|determined|analyzed/i },
];

// ── SubagentExecutor ──────────────────────────────────────────────────

/**
 * Layer 4: Parallel Subagent Execution
 *
 * Takes divided sub-tasks and executes each one as a parallel subagent
 * using existing model routings. Supports:
 *  - Parallel execution with configurable concurrency
 *  - Automatic retry on failure
 *  - Goalpost detection for streaming summaries
 *  - Tool access (context_search, web_search, code_execution)
 */
export class SubagentExecutor {
  private readonly fallbackRouter: FallbackRouter;

  constructor() {
    this.fallbackRouter = new FallbackRouter();
  }

  /**
   * Execute all sub-tasks in parallel.
   *
   * @returns Array of subagent results
   * @param onGoalpost Optional callback for emitting goalpost events during execution
   */
  async execute(
    ctx: FusionRequestContext,
    subTasks: SubTask[],
    options: {
      onGoalpost?: (event: GoalpostEvent) => void;
      signal?: AbortSignal;
    } = {},
  ): Promise<SubagentResult[]> {
    const { signal: _signal } = ctx;
    const tasks = subTasks.slice(0, 8); // Cap at 8 concurrent subagents

    if (tasks.length === 0) {
      log.warn("no sub-tasks to execute");
      return [];
    }

    log.info("executing subagents", { count: tasks.length });

    // Execute all sub-tasks in parallel using Promise.allSettled
    // so one failure doesn't cancel others
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
   */
  private async executeSingle(
    ctx: FusionRequestContext,
    subTask: SubTask,
    options: {
      onGoalpost?: (event: GoalpostEvent) => void;
      signal?: AbortSignal;
    },
  ): Promise<SubagentResult> {
    const modelRouting = subTask.suggested_model_routing;
    const startTime = performance.now();

    log.info("starting subagent", { subTask: subTask.id, modelRouting, focus: subTask.focus_area });

    let lastError: string | undefined;
    let allContent = "";

    for (let attempt = 1; attempt <= MAX_SUBAGENT_RETRIES; attempt++) {
      try {
        // Build a focused subagent prompt
        const subagentMessages = this.buildSubagentMessages(ctx, subTask, attempt);

        const response = await this.fallbackRouter.callWithFallback({
          logicalModel: modelRouting,
          requestData: {
            model: modelRouting,
            messages: subagentMessages,
            max_tokens: 4096,
          } as Record<string, unknown>,
          targetProtocol: "openai",
          signal: options.signal,
          validateResponse: false,
        });

        // Extract content from response
        const content = this.extractContent(response);
        allContent += (allContent ? "\n\n" : "") + content;

        // Check for goalpost events
        if (options.onGoalpost) {
          this.detectGoalposts(subTask, content, options.onGoalpost);
        }

        const durationMs = Math.round(performance.now() - startTime);
        log.info("subagent completed", {
          subTask: subTask.id,
          attempt,
          contentLength: content.length,
          durationMs,
        });

        return {
          subTask,
          success: true,
          usedModelRouting: modelRouting,
          content,
          durationMs,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);

        // Check if we should retry
        if (attempt < MAX_SUBAGENT_RETRIES && this.shouldRetry(err)) {
          log.warn("subagent retrying", {
            subTask: subTask.id,
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
      }
    }

    const durationMs = Math.round(performance.now() - startTime);
    return {
      subTask,
      success: allContent.length > 0,
      usedModelRouting: modelRouting,
      content: allContent,
      error: lastError,
      durationMs,
    };
  }

  /**
   * Build focused messages for a subagent based on the sub-task.
   */
  private buildSubagentMessages(
    ctx: FusionRequestContext,
    subTask: SubTask,
    attempt: number,
  ): unknown[] {
    const { messages } = ctx;

    // Include system prompt + relevant context + the sub-task description
    const systemPrompt = {
      role: "system",
      content: `You are a focused subagent working on a specific aspect of a larger task.

Your focus area: ${subTask.focus_area}
Your sub-task: ${subTask.description}

Provide thorough, detailed analysis and output for your assigned area. Be specific and actionable.`,
    };

    // Use the original messages but with a focus prompt
    const focusedMessages = [
      systemPrompt,
      ...messages.slice(-10), // Recent context
      {
        role: "user",
        content: attempt > 1
          ? `[Retry ${attempt}] Focus specifically on: ${subTask.description} in the area of ${subTask.focus_area}. Provide a complete and thorough response.`
          : `Please complete the following sub-task: ${subTask.description}\n\nFocus area: ${subTask.focus_area}`,
      },
    ];

    return focusedMessages;
  }

  /**
   * Extract text content from a provider response.
   */
  private extractContent(response: Record<string, unknown>): string {
    // OpenAI format
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (choices && choices.length > 0) {
      const message = choices[0]?.["message"] as Record<string, unknown> | undefined;
      if (message && typeof message["content"] === "string") {
        return message["content"];
      }
    }

    // Anthropic format
    const content = response["content"] as Array<Record<string, unknown>> | undefined;
    if (content && Array.isArray(content)) {
      return content
        .filter((b) => b["type"] === "text")
        .map((b) => String(b["text"] ?? ""))
        .join("\n");
    }

    // Fallback: stringify the whole response
    return JSON.stringify(response);
  }

  /**
   * Detect goalpost events in subagent output.
   */
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
          transcriptPortion: content.slice(-500), // Last 500 chars for context
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  /**
   * Determine if an error is retryable.
   */
  private shouldRetry(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    const nonRetryable = [
      "invalid_request_error",
      "invalid_api_key",
      "insufficient_quota",
      "context_length_exceeded",
    ];
    for (const pattern of nonRetryable) {
      if (msg.toLowerCase().includes(pattern)) return false;
    }
    return true;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
