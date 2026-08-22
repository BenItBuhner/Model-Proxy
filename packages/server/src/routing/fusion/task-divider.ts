import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../fallback.ts";
import type { FusionRequestContext, SubTask } from "./types.ts";
import { searchConversationContext } from "./context-search.ts";

const log = createLogger("routing.fusion.task-divider");

/** Max output tokens for the divider model. */
const DIVIDER_MAX_TOKENS = 131072;

/** Fallback division budget when task_divider.timeout_seconds is absent. */
const DEFAULT_DIVIDER_BUDGET_SECONDS = 180;

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of real) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/** Rough token estimate. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Tool schemas for the task divider agent ──────────────────────────

const DIVIDER_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_context",
      description: "Search the full conversation context for relevant information. Unfiltered access to all prior messages.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query to find relevant context" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "divide_task",
      description: "Divide the current task into focused sub-tasks for parallel subagent execution. Each sub-task should be specific and independently solvable.",
      parameters: {
        type: "object",
        properties: {
          sub_tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "Unique identifier for this sub-task" },
                description: { type: "string", description: "Detailed description of what this sub-task should accomplish" },
                focus_area: { type: "string", description: "Specific focus domain (e.g. 'styling', 'backend', 'database', 'api', 'testing', 'research', 'reasoning')" },
                suggested_model_routing: { type: "string", description: "Existing model routing name best suited for this task" },
              },
              required: ["id", "description", "focus_area", "suggested_model_routing"],
            },
          },
        },
        required: ["sub_tasks"],
      },
    },
  },
];

function buildDividerSystemPrompt(allowedModels: string[]): string {
  const modelsLine = allowedModels.length > 0
    ? `Available model routings for suggested_model_routing (use ONLY these exact names): ${allowedModels.join(", ")}.`
    : "Use the routing name provided by the pipeline for suggested_model_routing.";

  return `You are an expert task division agent inside a multi-model fusion pipeline. Your role is to analyze the full conversation context and divide the CURRENT task into focused, independently solvable RESEARCH sub-tasks.

UNDERSTAND THE EXECUTION ENVIRONMENT:
- The sub-tasks you define are handed to isolated RESEARCH/REASONING subagents. Those subagents run in a sealed sandbox: they cannot edit files, run project commands, deploy, take any real-world action, or call any tools. Their only deliverable is written analysis from the context briefing supplied by the Fusion proxy.
- A separate final "fusion" synthesis model reads their analysis and is the ONLY entity that produces the user-facing response and performs real actions.
- Therefore, write every sub-task description as an ANALYSIS/RESEARCH assignment ("Analyze…", "Investigate…", "Design…", "Recommend exact code for…"), NEVER as an execution order ("Implement…", "Deploy…", "Edit file X…"). Execution-style descriptions cause subagents to hallucinate actions they cannot perform.

For each sub-task, specify:
1. A unique ID
2. A clear research/analysis description of what the subagent should figure out and recommend
3. The focus area (e.g., 'styling', 'backend', 'database', 'api', 'testing', 'research', 'reasoning')
4. suggested_model_routing — ${modelsLine}

Be thorough but practical. Aim for sub-tasks that can run in parallel without dependency conflicts, each self-contained enough for a dedicated subagent to research independently.

You also run in a constrained environment: your ONLY tools are search_context() (to explore the conversation) and divide_task() (to output your division). Do not attempt anything else. You MUST call divide_task() to output your division result.`;
}

// ── TaskDividerAgent ─────────────────────────────────────────────────

/**
 * Layer 3: Task Division Agent
 *
 * Uses a configured model with tool-calling to divide the task.
 * Implements a multi-layer fallback strategy:
 *   1. Try the primary divider model with tool-calling
 *   2. If that fails, try an alternative model
 *   3. If that fails, use heuristic content-based division
 *   4. Only as last resort, return a single catch-all task
 */
export class TaskDividerAgent {
  private readonly fallbackRouter: FallbackRouter;

  constructor() {
    this.fallbackRouter = new FallbackRouter();
  }

  async divide(ctx: FusionRequestContext): Promise<SubTask[]> {
    const { fusionConfig, messages } = ctx;
    const primaryModel = fusionConfig.task_divider.model_routing;
    const maxSubtasks = fusionConfig.task_divider.max_subtasks;

    // Hard wall-clock budget for the entire division phase. Without this a
    // slow fallback model (5-min provider timeouts x 3 rounds x N models)
    // can starve the whole pipeline for 20+ minutes before heuristics kick in.
    const budgetSeconds = fusionConfig.task_divider.timeout_seconds ?? DEFAULT_DIVIDER_BUDGET_SECONDS;
    const deadlineAt = Date.now() + budgetSeconds * 1000;
    const budgetController = new AbortController();
    const budgetTimer = setTimeout(() => {
      log.warn("division budget exceeded, aborting in-flight divider calls", { budgetSeconds });
      budgetController.abort();
    }, budgetSeconds * 1000);

    log.info("dividing task", { primaryModel, maxSubtasks, budgetSeconds, messageCount: messages.length });

    try {
      // Layer 1: Try with the primary divider model (tool-calling)
      const subtasks1 = await this.tryDivideWithModel(ctx, primaryModel, maxSubtasks, deadlineAt, budgetController.signal);
      if (this.isRealDivision(subtasks1)) {
        log.info("task division succeeded with primary model", { count: subtasks1.length, model: primaryModel });
        return subtasks1;
      }

      // Layer 2: Try with an alternative model if primary failed
      const altModels = this.dividerFallbackModels(ctx);
      for (const altModel of altModels) {
        if (altModel === primaryModel) continue;
        if (Date.now() >= deadlineAt) {
          log.warn("division budget exhausted before trying alternative models", { budgetSeconds });
          break;
        }
        log.info("trying alternative divider model", { model: altModel });
        const subtasks2 = await this.tryDivideWithModel(ctx, altModel, maxSubtasks, deadlineAt, budgetController.signal);
        if (this.isRealDivision(subtasks2)) {
          log.info("task division succeeded with alternative model", { count: subtasks2.length, model: altModel });
          return subtasks2;
        }
      }
    } finally {
      clearTimeout(budgetTimer);
    }

    // Layer 3: Heuristic content-based division
    log.info("all divider models failed, using heuristic division");
    const heuristicTasks = this.heuristicDivide(ctx, maxSubtasks);
    if (heuristicTasks.length > 1) {
      log.info("heuristic division produced sub-tasks", { count: heuristicTasks.length });
      return heuristicTasks;
    }

    // Layer 4: Last resort — return the full context as a single task
    log.warn("all division strategies failed, returning single default task");
    return [this.createDefaultSubTask(primaryModel)];
  }

  /**
   * Try to divide the task using a specific model with a real tool loop:
   * search_context() calls are executed against the conversation and fed
   * back, retrying until divide_task() is actually produced (max 3 rounds).
   * Returns a single default task if division fails.
   */
  private async tryDivideWithModel(
    ctx: FusionRequestContext,
    modelRouting: string,
    maxSubtasks: number,
    deadlineAt: number,
    budgetSignal: AbortSignal,
  ): Promise<SubTask[]> {
    const { messages } = ctx;
    const signal = mergeAbortSignals(ctx.signal, budgetSignal);
    const maxRounds = 3;

    const systemPrompt = buildDividerSystemPrompt(
      this.subagentModelRoutings(ctx),
    );

    // Build context messages with token-aware truncation
    const contextMessages = this.buildTruncatedMessages(messages, systemPrompt);

    const workingMessages: unknown[] = [
      { role: "system", content: systemPrompt },
      ...contextMessages,
      {
        role: "user",
        content: `Please analyze this conversation and divide the task into up to ${maxSubtasks} focused sub-tasks. You MUST call the divide_task() function with your division. Use search_context() first if you need more context.`,
      },
    ];

    for (let round = 1; round <= maxRounds; round++) {
      if (Date.now() >= deadlineAt) {
        log.warn("division budget exhausted mid-loop", { model: modelRouting, round });
        return [this.createDefaultSubTask(modelRouting)];
      }
      const forceDivide = round === maxRounds;
      const dividerRequest: Record<string, unknown> = {
        model: modelRouting,
        messages: workingMessages,
        tools: DIVIDER_TOOLS,
        tool_choice: forceDivide
          ? { type: "function", function: { name: "divide_task" } }
          : "auto",
        max_tokens: DIVIDER_MAX_TOKENS,
      };

      let response: Record<string, unknown>;
      try {
        response = await this.fallbackRouter.callWithFallback({
          logicalModel: modelRouting,
          requestData: dividerRequest,
          targetProtocol: "openai",
          signal,
          principal: ctx.principal,
          validateResponse: false,
          extraHeaders: ctx.extraHeaders,
        });
      } catch (err) {
        if (forceDivide) {
          // Some providers reject object-form tool_choice — final retry with "auto"
          try {
            response = await this.fallbackRouter.callWithFallback({
              logicalModel: modelRouting,
              requestData: { ...dividerRequest, tool_choice: "auto" },
              targetProtocol: "openai",
              signal,
              principal: ctx.principal,
              validateResponse: false,
              extraHeaders: ctx.extraHeaders,
            });
          } catch (retryErr) {
            log.warn(`division failed for model ${modelRouting}`, { round, error: String(retryErr) });
            return [this.createDefaultSubTask(modelRouting)];
          }
        } else {
          log.warn(`division round failed for model ${modelRouting}`, { round, error: String(err) });
          return [this.createDefaultSubTask(modelRouting)];
        }
      }

      const parsed = this.parseDivisionResponse(response, modelRouting);
      if (parsed.length > 1 || (parsed.length === 1 && parsed[0].id !== "default-1")) {
        return parsed;
      }

      // No divide_task yet — execute any search_context calls and loop
      const searchCalls = this.extractSearchContextCalls(response);
      if (searchCalls.length > 0 && !forceDivide) {
        const assistantMessage = (response["choices"] as Array<Record<string, unknown>> | undefined)?.[0]?.["message"];
        if (assistantMessage !== undefined) workingMessages.push(assistantMessage);
        for (const call of searchCalls) {
          workingMessages.push({
            role: "tool",
            tool_call_id: call.id,
            name: "search_context",
            content: this.searchContext(messages, call.query),
          });
        }
        log.info("divider executed search_context, continuing loop", { round, searches: searchCalls.length });
        continue;
      }

      if (!forceDivide) {
        workingMessages.push({
          role: "user",
          content: "You did not call divide_task(). You MUST call the divide_task() function now with your sub-task division. Do not reply with plain text.",
        });
        log.info("divider produced no division, nudging and retrying", { round, model: modelRouting });
      }
    }

    return [this.createDefaultSubTask(modelRouting)];
  }

  /** True when the divider produced an actual division (not the default placeholder). */
  private isRealDivision(tasks: SubTask[]): boolean {
    if (tasks.length > 1) return true;
    return tasks.length === 1 && tasks[0].id !== "default-1";
  }

  /** Extract pending search_context tool calls from a divider response. */
  private extractSearchContextCalls(response: Record<string, unknown>): Array<{ id: string; query: string }> {
    const calls: Array<{ id: string; query: string }> = [];
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    const message = choices?.[0]?.["message"] as Record<string, unknown> | undefined;
    const toolCalls = message?.["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (!toolCalls) return calls;
    for (const tc of toolCalls) {
      const fn = tc["function"] as Record<string, unknown> | undefined;
      if (fn?.["name"] !== "search_context") continue;
      let query = "";
      try {
        const args = JSON.parse(String(fn["arguments"] ?? "{}"));
        query = typeof args?.query === "string" ? args.query : "";
      } catch { /* ignore malformed args */ }
      calls.push({ id: String(tc["id"] ?? `search-${calls.length + 1}`), query });
    }
    return calls;
  }

  /**
   * Execute a search_context call locally: keyword-match across the
   * conversation and return the most relevant excerpts.
   */
  private searchContext(messages: unknown[], query: string): string {
    return searchConversationContext(messages, query);
  }

  /** Subagent model routings for the active effort level (for the divider prompt). */
  private subagentModelRoutings(ctx: FusionRequestContext): string[] {
    const runtimeEffort = ctx.runtimeEffort ?? 2;
    const effortConfig = runtimeEffort === 3
      ? ctx.fusionConfig.effort_levels[3]
      : ctx.fusionConfig.effort_levels[2];
    return effortConfig?.model_routings ?? [ctx.fusionConfig.task_divider.model_routing];
  }

  private dividerFallbackModels(ctx: FusionRequestContext): string[] {
    const configured = [
      ctx.fusionConfig.task_divider.model_routing,
      ...(ctx.fusionConfig.effort_levels[2]?.model_routings ?? []),
      ...(ctx.fusionConfig.effort_levels[3]?.model_routings ?? []),
      ctx.fusionConfig.fusion.model_routing,
    ];
    return [...new Set(configured.filter((model) => model.length > 0))];
  }

  /**
   * Build context messages with token-aware truncation.
   */
  private buildTruncatedMessages(messages: unknown[], systemPrompt: string): unknown[] {
    const availableTokens = 800_000;
    let contextMessages = [...messages];

    const systemTokens = estimateTokens(systemPrompt);
    const taskPromptTokens = estimateTokens(
      `Please analyze this conversation and divide the task into up to 10 focused sub-tasks. You MUST call the divide_task() function with your division.`,
    );

    let totalMsgTokens = contextMessages.reduce<number>((t, m) => t + estimateTokens(JSON.stringify(m)), 0);
    let tries = 0;
    while ((systemTokens + taskPromptTokens + totalMsgTokens) > availableTokens && contextMessages.length > 2 && tries < 10) {
      if (contextMessages.length > 5) {
        contextMessages.splice(1, 1);
      } else {
        contextMessages.shift();
      }
      totalMsgTokens = contextMessages.reduce<number>((t, m) => t + estimateTokens(JSON.stringify(m)), 0);
      tries++;
    }

    return contextMessages;
  }

  /**
   * Parse the tool-call response from the divider model with multiple fallback methods.
   */
  private parseDivisionResponse(
    response: Record<string, unknown>,
    defaultModel: string,
  ): SubTask[] {
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      return [this.createDefaultSubTask(defaultModel)];
    }

    const choice = choices[0];
    const message = choice["message"] as Record<string, unknown> | undefined;
    if (!message) return [this.createDefaultSubTask(defaultModel)];

    // Method 1: Extract from tool_calls (standard OpenAI format)
    const toolCalls = message["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        const fn = tc["function"] as Record<string, unknown> | undefined;
        if (!fn) continue;
        const name = fn["name"] as string | undefined;
        if (name === "divide_task") {
          try {
            const args = JSON.parse(fn["arguments"] as string);
            if (args?.sub_tasks && Array.isArray(args.sub_tasks) && args.sub_tasks.length > 0) {
              return this.normalizeSubTasks(args.sub_tasks, defaultModel);
            }
          } catch {
            log.warn("failed to parse divide_task arguments from tc");
          }
        }
      }
    }

    // Method 2: Extract from content if it contains valid JSON
    const contentStr = typeof message["content"] === "string" ? message["content"] : "";
    if (contentStr) {
      const parsed = this.extractJsonFromContent(contentStr);
      if (parsed?.sub_tasks && Array.isArray(parsed.sub_tasks) && parsed.sub_tasks.length > 0) {
        return this.normalizeSubTasks(parsed.sub_tasks, defaultModel);
      }

      // Method 3: Try to extract structured info from the text and build sub-tasks
      const textSubtasks = this.extractSubTasksFromText(contentStr, defaultModel);
      if (textSubtasks.length > 1) {
        return textSubtasks;
      }
    }

    // Method 4: Check the finish_reason — if it was a tool call but we couldn't parse it,
    // check Anthropic-style content blocks
    const content = response["content"] as Array<Record<string, unknown>> | undefined;
    if (content && Array.isArray(content)) {
      for (const block of content) {
        if (block["type"] === "tool_use") {
          const input = block["input"] as Record<string, unknown> | undefined;
          if (input?.sub_tasks && Array.isArray(input.sub_tasks) && input.sub_tasks.length > 0) {
            return this.normalizeSubTasks(input.sub_tasks, defaultModel);
          }
        }
      }
    }

    return [this.createDefaultSubTask(defaultModel)];
  }

  /**
   * Try to extract sub-task definitions from free-text content when tool-calling fails.
   * Looks for patterns like "1.", "2." or "- " to identify distinct task areas.
   */
  private extractSubTasksFromText(content: string, defaultModel: string): SubTask[] {
    const tasks: SubTask[] = [];
    const lines = content.split("\n");

    let currentTask: string[] = [];
    const bulletPattern = /^[\s]*[-*\d]+[\.\)]\s+(.+)/i;

    for (const line of lines) {
      const match = line.match(bulletPattern);
      if (match) {
        if (currentTask.length > 0) {
          const taskText = currentTask.join(" ").trim();
          if (taskText.length > 10) {
            tasks.push(this.makeSubTaskFromText(taskText, defaultModel, tasks.length + 1));
          }
        }
        currentTask = [match[1]];
      } else if (line.trim()) {
        currentTask.push(line.trim());
      }
    }

    // Don't forget the last task
    if (currentTask.length > 0) {
      const taskText = currentTask.join(" ").trim();
      if (taskText.length > 10) {
        tasks.push(this.makeSubTaskFromText(taskText, defaultModel, tasks.length + 1));
      }
    }

    return tasks;
  }

  /**
   * Create a sub-task from extracted text, inferring focus area from content.
   */
  private makeSubTaskFromText(text: string, defaultModel: string, index: number): SubTask {
    const lower = text.toLowerCase();
    let focus = "general";
    if (lower.includes("code") || lower.includes("implement") || lower.includes("function")) focus = "code";
    else if (lower.includes("api") || lower.includes("endpoint")) focus = "api";
    else if (lower.includes("data") || lower.includes("database") || lower.includes("schema")) focus = "data";
    else if (lower.includes("test") || lower.includes("debug") || lower.includes("bug")) focus = "testing";
    else if (lower.includes("styl") || lower.includes("css") || lower.includes("ui") || lower.includes("design")) focus = "styling";
    else if (lower.includes("research") || lower.includes("analy") || lower.includes("explain")) focus = "research";
    else if (lower.includes("reason") || lower.includes("plan") || lower.includes("strategy")) focus = "reasoning";

    return {
      id: `extracted-${index}`,
      description: text,
      focus_area: focus,
      suggested_model_routing: defaultModel,
    };
  }

  /**
   * Heuristic content-based division when model-based division fails.
   * Analyzes the conversation and creates sub-tasks based on message roles, topics, and requests.
   */
  private heuristicDivide(ctx: FusionRequestContext, maxSubtasks: number): SubTask[] {
    const { messages } = ctx;
    if (messages.length === 0) return [];

    const tasks: SubTask[] = [];
    const allText = JSON.stringify(messages).toLowerCase();
    const defaultModel = ctx.fusionConfig.task_divider.model_routing;

    // Identify distinct focus areas from the conversation content
    const focusKeywords: Array<{ area: string; keywords: string[] }> = [
      { area: "code", keywords: ["implement", "function", "class ", "def ", "const ", "import ", "require(", "component"] },
      { area: "api", keywords: ["api", "endpoint", "route", "http", "rest", "graphql"] },
      { area: "data", keywords: ["database", "schema", "query", "data", "store", "migration"] },
      { area: "testing", keywords: ["test", "debug", "bug", "error", "fix", "lint"] },
      { area: "styling", keywords: ["style", "css", "ui", "design", "layout", "theme"] },
      { area: "research", keywords: ["research", "analyze", "compare", "document", "explain", "investigate"] },
      { area: "reasoning", keywords: ["reason", "plan", "strategy", "approach", "architecture", "design"] },
    ];

    const detectedAreas = focusKeywords
      .filter(({ keywords }) => keywords.some(k => allText.includes(k)))
      .map(({ area }) => area);

    if (detectedAreas.length >= 2) {
      for (const area of detectedAreas.slice(0, maxSubtasks)) {
        tasks.push({
          id: `heuristic-${tasks.length + 1}`,
          description: `Handle the ${area}-related aspects of the request. Analyze all relevant context in the conversation.`,
          focus_area: area,
          suggested_model_routing: area === "research" || area === "reasoning" ? "glm-5.2" : defaultModel,
        });
      }
    }

    // Always include a general catch-all for anything we missed
    if (tasks.length > 0) {
      tasks.push({
        id: `heuristic-${tasks.length + 1}`,
        description: "Handle any remaining aspects of the request not covered by the specialized sub-tasks above. Synthesize findings." ,
        focus_area: "general",
        suggested_model_routing: defaultModel,
      });
    }

    return tasks;
  }

  // ── JSON extraction from text ─────────────────────────────────────

  private extractJsonFromContent(content: string): Record<string, unknown> | null {
    // Try to find a JSON block in the content
    const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch { /* fall through */ }
    }
    // Try parsing the entire content
    try {
      return JSON.parse(content);
    } catch { /* fall through */ }
    // Try finding a JSON object anywhere in the text
    const looseMatch = content.match(/\{[\s\S]*?"sub_tasks"[\s\S]*?\}/);
    if (looseMatch) {
      try {
        return JSON.parse(looseMatch[0]);
      } catch { /* fall through */ }
    }
    return null;
  }

  // ── Normalization helpers ─────────────────────────────────────────

  private normalizeSubTasks(tasks: unknown[], defaultModel: string): SubTask[] {
    return tasks.slice(0, 10).map((t: unknown, i: number) => {
      const task = t as Record<string, unknown>;
      return {
        id: String(task["id"] ?? `subtask-${i + 1}`),
        description: String(task["description"] ?? ""),
        focus_area: String(task["focus_area"] ?? "general"),
        suggested_model_routing: String(task["suggested_model_routing"] ?? defaultModel),
      };
    });
  }

  private createDefaultSubTask(defaultModel: string): SubTask {
    return {
      id: "default-1",
      description: "Process the full request with the available model routing",
      focus_area: "general",
      suggested_model_routing: defaultModel,
    };
  }
}
