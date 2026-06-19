import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../fallback.ts";
import type { FusionRequestContext, SubagentResult, FusionResult } from "./types.ts";

const log = createLogger("routing.fusion.fuser");

// ── ResponseFuser ────────────────────────────────────────────────────

/**
 * Layer 5: Response Fusion
 *
 * Takes completed subagent outputs and produces the final fused response.
 *
 * Strategy (sequential_append):
 * 1. Append all subagent outputs sequentially, keeping them isolated
 * 2. Feed the appended content + original request to the fusion model
 * 3. The fusion model streams its reasoning over all subagent work
 * 4. Returns the final response
 */
export class ResponseFuser {
  private readonly fallbackRouter: FallbackRouter;

  constructor() {
    this.fallbackRouter = new FallbackRouter();
  }

  /**
   * Fuse subagent outputs into a single coherent response.
   *
   * @param ctx The original fusion request context
   * @param subagentResults Results from all executed subagents
   * @returns The final fusion result
   */
  async fuse(
    ctx: FusionRequestContext,
    subagentResults: SubagentResult[],
  ): Promise<FusionResult> {
    const { fusionConfig, messages, signal } = ctx;
    const fusionModel = fusionConfig.fusion.model_routing;
    const wireProtocol = fusionConfig.fusion.wire_protocol;

    log.info("fusing subagent outputs", {
      subagentCount: subagentResults.length,
      fusionModel,
      wireProtocol,
    });

    // Step 1: Build the sequential append of all subagent outputs
    const appendedContent = this.buildSequentialAppend(subagentResults);

    // Step 2: Build the synthesis prompt for the fusion model
    const synthesisMessages = this.buildSynthesisMessages(
      messages,
      appendedContent,
      subagentResults,
    );

    // Step 3: Feed to the fusion model
    try {
      const response = await this.fallbackRouter.callWithFallback({
        logicalModel: fusionModel,
        requestData: {
          model: fusionModel,
          messages: synthesisMessages,
          max_tokens: 8192,
        } as Record<string, unknown>,
        targetProtocol: wireProtocol === "anthropic" ? "anthropic" : "openai",
        signal,
        validateResponse: false,
      });

      const content = this.extractContent(response);

      log.info("fusion complete", {
        contentLength: content.length,
        wireProtocol,
        subagentCount: subagentResults.length,
      });

      return {
        content,
        wireProtocol,
        subagentResults,
        fusedByModelRouting: fusionModel,
      };
    } catch (err) {
      log.error("fusion model call failed", { error: String(err) });
      // Fallback: return the concatenated subagent outputs directly
      return {
        content: appendedContent,
        wireProtocol,
        subagentResults,
        fusedByModelRouting: fusionModel,
      };
    }
  }

  /**
   * Stream variant: yields SSE events as the fusion model streams.
   */
  async *fuseStream(
    ctx: FusionRequestContext,
    subagentResults: SubagentResult[],
  ): AsyncGenerator<string, void, unknown> {
    const { fusionConfig, messages, signal } = ctx;
    const fusionModel = fusionConfig.fusion.model_routing;
    const wireProtocol = fusionConfig.fusion.wire_protocol;

    // Step 1: Build the sequential append
    const appendedContent = this.buildSequentialAppend(subagentResults);

    // Step 2: Build synthesis messages
    const synthesisMessages = this.buildSynthesisMessages(
      messages,
      appendedContent,
      subagentResults,
    );

    // Step 3: Stream from the fusion model
    yield this.encodeEvent("reasoning", {
      type: "reasoning",
      summary: `[Fusion] Synthesizing ${subagentResults.length} subagent outputs into final response...`,
    });

    try {
      const streamGen = this.fallbackRouter.streamWithFallback({
        logicalModel: fusionModel,
        requestData: {
          model: fusionModel,
          messages: synthesisMessages,
          max_tokens: 8192,
          stream: true,
        } as Record<string, unknown>,
        targetProtocol: wireProtocol === "anthropic" ? "anthropic" : "openai",
        signal,
      });

      for await (const chunk of streamGen) {
        yield chunk;
      }
    } catch (err) {
      log.error("fusion stream failed, returning raw appended content", { error: String(err) });
      yield this.encodeEvent("reasoning", {
        type: "reasoning",
        summary: "[Fusion] Synthesis failed. Returning raw subagent outputs.",
      });
      yield this.encodeEvent("completion", {
        type: "completion",
        content: appendedContent,
      });
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  /**
   * Build the sequentially appended content from all subagent outputs.
   * Each subagent's output is kept isolated with clear headers.
   */
  private buildSequentialAppend(results: SubagentResult[]): string {
    if (results.length === 0) return "";

    const parts: string[] = [];

    for (const result of results) {
      if (!result.success || !result.content) continue;

      parts.push(`[Sub-Task: ${result.subTask.focus_area}]`);
      parts.push(`${result.subTask.description}`);
      parts.push("");
      parts.push(result.content.trim());
      parts.push("");
      parts.push("---");
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * Build the messages array for the synthesis model.
   */
  private buildSynthesisMessages(
    originalMessages: unknown[],
    appendedContent: string,
    results: SubagentResult[],
  ): unknown[] {
    const successfulResults = results.filter((r) => r.success && r.content.length > 0);

    const systemPrompt = {
      role: "system",
      content: `You are the final synthesis model in a multi-agent fusion system.

You have received the outputs from ${successfulResults.length} specialized subagents that worked in parallel on different aspects of the original task.

Your job:
1. Review all subagent outputs carefully
2. Synthesize them into a coherent, comprehensive final response
3. Eliminate redundancy while preserving important details
4. Maintain the original user's intent and tone
5. Your response should read as a single, unified answer — not a collection of separate parts

The subagent outputs are separated by section markers. Each section indicates its focus area.`,
    };

    // Build a message that orients the model with the subagent work
    const fusionPrompt = {
      role: "user",
      content: `The following is the sequential output from ${successfulResults.length} parallel subagents, each working on a different aspect of the original request:\n\n${appendedContent}\n\nPlease synthesize these into a coherent, comprehensive final response that addresses the original request.`,
    };

    return [
      systemPrompt,
      ...originalMessages.slice(-5), // Last few original messages for context
      fusionPrompt,
    ];
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

    return JSON.stringify(response);
  }

  private encodeEvent(_eventType: string, data: unknown): string {
    return `data: ${JSON.stringify(data)}\n\n`;
  }
}
