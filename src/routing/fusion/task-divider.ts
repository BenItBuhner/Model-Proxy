import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../fallback.ts";
import type { FusionRequestContext, SubTask } from "./types.ts";

const log = createLogger("routing.fusion.task-divider");

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
                focus_area: { type: "string", description: "Specific focus domain (e.g. 'styling', 'backend', 'database', 'api', 'testing')" },
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

const DIVIDER_SYSTEM_PROMPT = `You are an expert task division agent. Your role is to analyze the full conversation context and divide complex tasks into focused, independently solvable sub-tasks.

For each sub-task, specify:
1. A unique ID
2. A clear description of what needs to be accomplished
3. The focus area (e.g., 'styling', 'backend', 'database', 'api', 'testing', 'research', 'reasoning')
4. Which existing model routing is best suited (choose from available routings)

Be thorough but practical. Aim for sub-tasks that can execute in parallel without dependency conflicts. Each sub-task should be self-contained enough for a dedicated subagent to solve independently.

Use search_context() to explore the full conversation before dividing.`;

// ── TaskDividerAgent ─────────────────────────────────────────────────

/**
 * Layer 3: Task Division Agent
 *
 * Uses a configured model (default: GLM-5.2) with tool-calling to:
 * 1. Search the full conversation context unfiltered
 * 2. Divide the task into focused, parallelizable sub-tasks
 * 3. Return the list of sub-tasks
 */
export class TaskDividerAgent {
  private readonly fallbackRouter: FallbackRouter;

  constructor() {
    this.fallbackRouter = new FallbackRouter();
  }

  /**
   * Divide the task in the given fusion context into sub-tasks.
   *
   * Uses the configured task_divider model_routing to invoke the dividing
   * model with tool-calling capabilities.
   */
  async divide(ctx: FusionRequestContext): Promise<SubTask[]> {
    const { fusionConfig, messages, signal } = ctx;
    const dividerModel = fusionConfig.task_divider.model_routing;
    const maxSubtasks = fusionConfig.task_divider.max_subtasks;

    log.info("dividing task", { dividerModel, maxSubtasks, messageCount: messages.length });

    // Build the divider request — asks the model to analyze and divide
    const dividerRequest: Record<string, unknown> = {
      model: dividerModel,
      messages: [
        { role: "system", content: DIVIDER_SYSTEM_PROMPT },
        ...messages.slice(-20), // Focus on recent context (divider itself searches deeper via tool)
        {
          role: "user",
          content: `Please analyze this conversation and divide the task into up to ${maxSubtasks} focused sub-tasks. Use search_context() to explore the full context, then use divide_task() to produce the division.`,
        },
      ],
      tools: DIVIDER_TOOLS,
      tool_choice: "auto",
      max_tokens: 4096,
    };

    try {
      const response = await this.fallbackRouter.callWithFallback({
        logicalModel: dividerModel,
        requestData: dividerRequest,
        targetProtocol: "openai", // Use OpenAI protocol for tool-calling
        signal,
        validateResponse: false,
      });

      return this.parseDivisionResponse(response, dividerModel);
    } catch (err) {
      log.error("task division failed", { error: String(err) });
      // Fallback: return a single generic sub-task
      return [this.createDefaultSubTaskFromCtx(ctx)];
    }
  }

  /**
   * Parse the tool-call response from the divider model.
   * Extracts the divide_task function call and its sub_tasks argument.
   */
  private parseDivisionResponse(
    response: Record<string, unknown>,
    defaultModel: string,
  ): SubTask[] {
    // Extract from OpenAI response format
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      return [this.createDefaultSubTask(defaultModel)];
    }

    const message = choices[0]?.["message"] as Record<string, unknown> | undefined;
    if (!message) return [this.createDefaultSubTask(defaultModel)];

    const toolCalls = message["tool_calls"] as Array<Record<string, unknown>> | undefined;
    if (!toolCalls || toolCalls.length === 0) {
      // If no tool calls, check the content directly for JSON
      const content = typeof message["content"] === "string" ? message["content"] : "";
      const parsed = this.extractJsonFromContent(content);
      if (parsed?.sub_tasks && Array.isArray(parsed.sub_tasks)) {
        return this.normalizeSubTasks(parsed.sub_tasks, defaultModel);
      }
      return [this.createDefaultSubTask(defaultModel)];
    }

    // Find the divide_task function call
    for (const tc of toolCalls) {
      const fn = tc["function"] as Record<string, unknown> | undefined;
      if (!fn) continue;
      const name = fn["name"] as string | undefined;
      if (name === "divide_task") {
        try {
          const args = JSON.parse(fn["arguments"] as string);
          if (args?.sub_tasks && Array.isArray(args.sub_tasks)) {
            return this.normalizeSubTasks(args.sub_tasks, defaultModel);
          }
        } catch {
          log.warn("failed to parse divide_task arguments");
        }
      }
    }

    return [this.createDefaultSubTask(defaultModel)];
  }

  /**
   * Try to extract a JSON object from text content.
   */
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
    return null;
  }

  /**
   * Normalize sub-tasks from the divider response, filling in defaults.
   */
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

  /**
   * Create a single default sub-task covering the entire request.
   */
  private createDefaultSubTask(defaultModel: string): SubTask {
    return {
      id: "default-1",
      description: "Process the full request with the available model routing",
      focus_area: "general",
      suggested_model_routing: defaultModel,
    };
  }

  /**
   * Create a default sub-task from a FusionRequestContext.
   */
  private createDefaultSubTaskFromCtx(ctx: FusionRequestContext): SubTask {
    return this.createDefaultSubTask(ctx.fusionConfig.task_divider.model_routing);
  }
}
