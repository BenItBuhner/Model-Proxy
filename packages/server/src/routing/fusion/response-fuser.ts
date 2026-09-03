import { usageSnapshotFromCounts } from "../../shared/usage-snapshot.ts";
import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../fallback.ts";
import { SYSTEM_DEFAULT_CONTEXT_WINDOW } from "../context-window.ts";
import { resolvePricing, calculateCosts } from "../../observability/pricing.ts";
import { resolveDeclaredContextWindow } from "../context-window.ts";
import { modelConfigLoader } from "../../config/model-loader.ts";
import type { FusionCostEntry, FusionRequestContext, FusionStep, SubagentResult, FusionResult } from "./types.ts";
import {
  ReasoningSummarizer,
  formatReasoningChunk,
  parseOpenAIDelta,
  splitSseEvents,
  streamSummaryPieces,
  stripToolCallArtifacts,
} from "./reasoning-summarizer.ts";
import { emitFusion, nowIso } from "./fusion-events.ts";

const log = createLogger("routing.fusion.fuser");

/** Max output tokens for the synthesis model — matches 1M-context models. */
const FUSER_MAX_TOKENS = 131072;

/** Max context messages to include. */
const MAX_CONTEXT_MESSAGES = 200;

/** Minimum input room preserved for synthesis after reserving output tokens. */
const MIN_SYNTHESIS_INPUT_TOKENS = 8_000;

/** Output headroom for the final synthesis model. */
const MAX_OUTPUT_RESERVE_RATIO = 0.25;

interface SynthesisContextBudget {
  contextWindow: number;
  inputBudgetTokens: number;
  outputBudgetTokens: number;
}

interface SynthesisContextPack {
  messages: unknown[];
  estimatedTokens: number;
  droppedMessages: number;
  mix: {
    first: number;
    relevant: number;
    anchors: number;
    recent: number;
  };
}

/** Rough token estimate: chars / 4. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessageTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(JSON.stringify(message));
  }
  return total;
}


/**
 * ResponseFuser (Layer 5)
 *
 * Takes completed subagent outputs and produces the final fused response.
 * Includes FULL context (not just last 5 messages) for large conversations.
 * Also records the synthesis step in the pipeline trace.
 */
export class ResponseFuser {
  private readonly fallbackRouter: FallbackRouter;
  private readonly summarizer: ReasoningSummarizer;

  constructor(summarizer?: ReasoningSummarizer) {
    this.fallbackRouter = new FallbackRouter();
    this.summarizer = summarizer ?? new ReasoningSummarizer(this.fallbackRouter);
  }

  /**
   * Fuse subagent outputs into a single coherent response.
   * @param steps Accumulating pipeline trace steps — we append the synthesis step here.
   * @param costs Accumulating cost entries — we append the synthesis cost here.
   */
  async fuse(
    ctx: FusionRequestContext,
    subagentResults: SubagentResult[],
    steps: FusionStep[] = [],
    costs: FusionCostEntry[] = [],
  ): Promise<FusionResult> {
    const { fusionConfig, messages, signal } = ctx;
    const fusionModel = ctx.kernelSynthesisRouting ?? fusionConfig.fusion.model_routing;
    const wireProtocol = fusionConfig.fusion.wire_protocol;

    log.info("fusing subagent outputs", {
      subagentCount: subagentResults.length,
      fusionModel,
      wireProtocol,
    });

    const appendedContent = this.buildSequentialAppend(subagentResults);
    const synthesisBudget = this.synthesisContextBudget(ctx, fusionModel);

    const synthesisMessages = this.buildSynthesisMessages(
      messages,
      appendedContent,
      subagentResults,
      ctx,
      synthesisBudget,
    );

    const synthStart = performance.now();
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "synthesis",
      status: "started",
      modelRouting: fusionModel,
      detail: { subagentCount: subagentResults.length },
    });

    try {
      const fusionRequestData: Record<string, unknown> = {
        model: fusionModel,
        messages: synthesisMessages,
        max_tokens: synthesisBudget.outputBudgetTokens,
        ...(ctx.kernelSynthesisReasoningEffort !== undefined ? { reasoning_effort: ctx.kernelSynthesisReasoningEffort } : {}),
      };
      const tools = (ctx.requestData?.["tools"] as unknown[] | undefined);
      const toolChoice = ctx.requestData?.["tool_choice"];
      if (tools && tools.length > 0) {
        fusionRequestData["tools"] = tools;
        if (toolChoice !== undefined) {
          fusionRequestData["tool_choice"] = toolChoice;
        }
      }

      const response = await this.fallbackRouter.callWithFallback({
        logicalModel: fusionModel,
        requestData: fusionRequestData,
        targetProtocol: wireProtocol === "anthropic" ? "anthropic" : "openai",
        signal,
        principal: ctx.principal,
        validateResponse: false,
        extraHeaders: ctx.extraHeaders,
      });

      const toolCalls = this.extractToolCalls(response);
      const content = this.extractContent(response, toolCalls);
      const reasoning = this.extractStringField(response, "reasoning");
      const reasoningContent = this.extractStringField(response, "reasoning_content");
      const finishReason = this.extractFinishReason(response);
      const usage = this.extractUsage(response);
      const synthMs = Math.round(performance.now() - synthStart);

      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "synthesis",
        status: "completed",
        durationMs: synthMs,
        modelRouting: fusionModel,
      });

      // Record synthesis step
      steps.push({
        type: "synthesis",
        label: "Response Synthesis",
        startedAt: new Date(Date.now() - synthMs).toISOString(),
        durationMs: synthMs,
        modelRouting: fusionModel,
        details: {
          contentLength: content?.length ?? 0,
          hasToolCalls: !!(toolCalls && toolCalls.length > 0),
          subagentCount: subagentResults.length,
          successfulSubagents: subagentResults.filter(r => r.success).length,
          usage,
        },
      });

      // Record synthesis cost
      if (usage) {
        const pricing = resolvePricing({ requestedModel: fusionModel });
        const costResult = calculateCosts(usageSnapshotFromCounts(usage), pricing);
        costs.push({
          modelRouting: fusionModel,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          userCostUsd: costResult.userCostUsd,
          typicalCostUsd: costResult.typicalCostUsd,
        });
      }

      log.info("fusion complete", {
        contentLength: content?.length ?? 0,
        wireProtocol,
        subagentCount: subagentResults.length,
        hasToolCalls: !!toolCalls && toolCalls.length > 0,
        durationMs: synthMs,
      });

      return {
        content,
        reasoning,
        reasoningContent,
        toolCalls,
        finishReason,
        wireProtocol,
        subagentResults,
        fusedByModelRouting: fusionModel,
        usage,
      };
    } catch (err) {
      const synthMs = Math.round(performance.now() - synthStart);
      log.error("fusion model call failed", { error: String(err), durationMs: synthMs });
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "synthesis",
        status: "failed",
        durationMs: synthMs,
        modelRouting: fusionModel,
        detail: { error: String(err) },
      });

      steps.push({
        type: "synthesis",
        label: "Response Synthesis (fallback)",
        startedAt: new Date(Date.now() - synthMs).toISOString(),
        durationMs: synthMs,
        modelRouting: fusionModel,
        details: { error: String(err), fallback: true },
      });

      return {
        content: appendedContent,
        wireProtocol,
        subagentResults,
        fusedByModelRouting: fusionModel,
      };
    }
  }

  async *fuseStream(
    ctx: FusionRequestContext,
    subagentResults: SubagentResult[],
  ): AsyncGenerator<string, void, unknown> {
    const { fusionConfig, messages, signal } = ctx;
    const fusionModel = ctx.kernelSynthesisRouting ?? fusionConfig.fusion.model_routing;
    const wireProtocol = fusionConfig.fusion.wire_protocol;
    const synthStart = performance.now();
    emitFusion(ctx, {
      type: "fusion.phase",
      at: nowIso(),
      phase: "synthesis",
      status: "started",
      modelRouting: fusionModel,
      detail: { subagentCount: subagentResults.length },
    });

    const appendedContent = this.buildSequentialAppend(subagentResults);
    const synthesisBudget = this.synthesisContextBudget(ctx, fusionModel);

    const synthesisMessages = this.buildSynthesisMessages(
      messages,
      appendedContent,
      subagentResults,
      ctx,
      synthesisBudget,
    );

    try {
      const fusionRequestData: Record<string, unknown> = {
        model: fusionModel,
        messages: synthesisMessages,
        max_tokens: synthesisBudget.outputBudgetTokens,
        stream: true,
        ...(ctx.kernelSynthesisReasoningEffort !== undefined ? { reasoning_effort: ctx.kernelSynthesisReasoningEffort } : {}),
      };
      const tools = (ctx.requestData?.["tools"] as unknown[] | undefined);
      const toolChoice = ctx.requestData?.["tool_choice"];
      if (tools && tools.length > 0) {
        fusionRequestData["tools"] = tools;
        if (toolChoice !== undefined) {
          fusionRequestData["tool_choice"] = toolChoice;
        }
      }

      const targetProtocol = wireProtocol === "anthropic"
        ? this.resolveAnthropicSynthesisStreamTarget(fusionModel)
        : "openai";
      const streamGen = this.fallbackRouter.streamWithFallback({
        logicalModel: fusionModel,
        requestData: fusionRequestData,
        targetProtocol,
        signal,
        principal: ctx.principal,
        extraHeaders: ctx.extraHeaders,
      });

      if (wireProtocol !== "anthropic" && this.summarizer.isEnabled(ctx)) {
        yield* this.streamWithReasoningSummaries(ctx, streamGen);
      } else if (wireProtocol === "anthropic" && targetProtocol === "openai") {
        yield* this.openAIStreamToAnthropic(ctx, streamGen);
      } else {
        for await (const chunk of streamGen) {
          yield chunk;
        }
      }
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "synthesis",
        status: "completed",
        durationMs: Math.round(performance.now() - synthStart),
        modelRouting: fusionModel,
      });
    } catch (err) {
      log.error("fusion stream failed", { error: String(err) });
      emitFusion(ctx, {
        type: "fusion.phase",
        at: nowIso(),
        phase: "synthesis",
        status: "failed",
        durationMs: Math.round(performance.now() - synthStart),
        modelRouting: fusionModel,
        detail: { error: String(err) },
      });
      if (wireProtocol === "anthropic") {
        yield* this.anthropicTextStream(ctx, fusionModel, appendedContent || "[Fusion synthesis failed]", "end_turn");
      } else {
        const fallbackChunk = {
          id: `chatcmpl-fallback-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: fusionModel,
          choices: [{
            index: 0,
            delta: { role: "assistant", content: appendedContent || "[Fusion synthesis failed]" },
            finish_reason: "stop",
          }],
        };
        yield `data: ${JSON.stringify(fallbackChunk)}\n\n`;
      }
    }
  }

  /** Convert an OpenAI-compatible SSE stream into Anthropic message events (used by the kernel fast path). */
  convertOpenAIStreamToAnthropic(
    ctx: FusionRequestContext,
    streamGen: AsyncGenerator<string, void, unknown>,
  ): AsyncGenerator<string, void, unknown> {
    return this.openAIStreamToAnthropic(ctx, streamGen);
  }

  private async *openAIStreamToAnthropic(
    ctx: FusionRequestContext,
    streamGen: AsyncGenerator<string, void, unknown>,
  ): AsyncGenerator<string, void, unknown> {
    const messageId = `msg-${ctx.requestId ?? Date.now()}`;
    const model = ctx.logicalModel;
    let textStarted = false;
    let blockIndex = 0;
    const toolBlockIndexes = new Map<number, number>();
    let stopped = false;
    const formatEvent = (event: string, payload: Record<string, unknown>) => this.anthropicEvent(event, payload);

    yield this.anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });

    const ensureTextBlock = function* (): Generator<string, void, unknown> {
      if (textStarted) return;
      textStarted = true;
      yield formatEvent("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: { type: "text", text: "" },
      });
    }.bind(this);

    const stopTextBlock = function* (): Generator<string, void, unknown> {
      if (!textStarted) return;
      yield formatEvent("content_block_stop", { type: "content_block_stop", index: blockIndex });
      blockIndex++;
      textStarted = false;
    }.bind(this);

    for await (const raw of streamGen) {
      for (const event of splitSseEvents(raw)) {
        const parsed = parseOpenAIDelta(event);
        if (parsed === null) continue;

        if (parsed.content.length > 0) {
          yield* ensureTextBlock();
          yield this.anthropicEvent("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "text_delta", text: parsed.content },
          });
        }

        for (const toolDelta of parsed.toolCallDeltas) {
          const toolIndex = typeof toolDelta["index"] === "number" ? toolDelta["index"] as number : 0;
          let toolBlockIndex = toolBlockIndexes.get(toolIndex);
          if (toolBlockIndex === undefined) {
            yield* stopTextBlock();
            toolBlockIndex = blockIndex++;
            toolBlockIndexes.set(toolIndex, toolBlockIndex);
            const fn = toolDelta["function"] as Record<string, unknown> | undefined;
            yield this.anthropicEvent("content_block_start", {
              type: "content_block_start",
              index: toolBlockIndex,
              content_block: {
                type: "tool_use",
                id: String(toolDelta["id"] ?? `toolu-${messageId}-${toolIndex}`),
                name: typeof fn?.["name"] === "string" ? fn["name"] : `tool_${toolIndex}`,
                input: {},
              },
            });
          }
          const fn = toolDelta["function"] as Record<string, unknown> | undefined;
          const partialJson = typeof fn?.["arguments"] === "string" ? fn["arguments"] : "";
          if (partialJson.length > 0) {
            yield this.anthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: toolBlockIndex,
              delta: { type: "input_json_delta", partial_json: partialJson },
            });
          }
        }

        if (parsed.finishReason !== undefined && !stopped) {
          yield* stopTextBlock();
          for (const index of toolBlockIndexes.values()) {
            yield this.anthropicEvent("content_block_stop", { type: "content_block_stop", index });
          }
          stopped = true;
          yield this.anthropicEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: this.openAIFinishReasonToAnthropic(parsed.finishReason), stop_sequence: null },
            usage: { output_tokens: 0 },
          });
          yield this.anthropicEvent("message_stop", { type: "message_stop" });
        }
      }
    }

    if (!stopped) {
      yield* stopTextBlock();
      for (const index of toolBlockIndexes.values()) {
        yield this.anthropicEvent("content_block_stop", { type: "content_block_stop", index });
      }
      yield this.anthropicEvent("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 0 },
      });
      yield this.anthropicEvent("message_stop", { type: "message_stop" });
    }
  }

  private async *anthropicTextStream(
    ctx: FusionRequestContext,
    model: string,
    text: string,
    stopReason: string,
  ): AsyncGenerator<string, void, unknown> {
    yield this.anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: `msg-${ctx.requestId ?? Date.now()}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    yield this.anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    });
    yield this.anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    });
    yield this.anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 });
    yield this.anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 0 },
    });
    yield this.anthropicEvent("message_stop", { type: "message_stop" });
  }

  private anthropicEvent(event: string, payload: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  private openAIFinishReasonToAnthropic(reason: string): string {
    if (reason === "tool_calls" || reason === "function_call") return "tool_use";
    if (reason === "length") return "max_tokens";
    if (reason === "content_filter") return "stop_sequence";
    return "end_turn";
  }

  private resolveAnthropicSynthesisStreamTarget(fusionModel: string): "openai" | "anthropic" {
    try {
      const config = modelConfigLoader.loadConfig(fusionModel);
      const routes = config.model_routings ?? [];
      if (routes.length > 0 && routes.every((route) => route.wire_protocol === "anthropic")) {
        return "anthropic";
      }
    } catch {
      // Fall back to OpenAI-compatible internal chunks; that is the common path
      // for the local providers and lets the fuser translate at the edge.
    }
    return "openai";
  }

  /**
   * Forward the synthesis model's stream to the client, but intercept its raw
   * reasoning deltas: buffer them into segments and stream live summaries
   * (via the turbo summarizer) on the reasoning channel instead. Content and
   * tool_call deltas pass through untouched.
   */
  private async *streamWithReasoningSummaries(
    ctx: FusionRequestContext,
    streamGen: AsyncGenerator<string, void, unknown>,
  ): AsyncGenerator<string, void, unknown> {
    const segmentChars = ctx.fusionConfig.summarizer.segment_chars;
    // Prefer flushing at paragraph boundaries once a reasonable amount of
    // reasoning has accumulated, so summaries track natural units of thought.
    const paragraphFlushChars = Math.max(300, Math.floor(segmentChars / 3));
    let reasoningBuf = "";
    let previousSummary: string | undefined;

    const self = this;
    async function* summarizeText(text: string): AsyncGenerator<string, void, unknown> {
      if (text.trim().length === 0) return;
      let summaryText = "";
      for await (const piece of streamSummaryPieces(
        self.summarizer,
        ctx,
        { label: "synthesis", text },
        previousSummary,
      )) {
        summaryText += piece;
        yield formatReasoningChunk(ctx, piece);
      }
      const trimmed = summaryText.trim();
      if (trimmed.length > 0) {
        yield formatReasoningChunk(ctx, "\n\n");
        previousSummary = trimmed;
        emitFusion(ctx, { type: "fusion.summary", at: nowIso(), label: "synthesis", text: trimmed });
      }
    }

    async function* flushReasoning(): AsyncGenerator<string, void, unknown> {
      const text = reasoningBuf;
      reasoningBuf = "";
      yield* summarizeText(text);
    }

    // Flush at a paragraph boundary when enough has accumulated, or hard-flush
    // when the segment budget is reached.
    async function* maybeFlushOnBoundary(): AsyncGenerator<string, void, unknown> {
      if (reasoningBuf.length >= paragraphFlushChars) {
        const boundary = reasoningBuf.lastIndexOf("\n\n");
        if (boundary >= Math.floor(paragraphFlushChars / 2)) {
          const text = reasoningBuf.slice(0, boundary);
          reasoningBuf = reasoningBuf.slice(boundary + 2);
          yield* summarizeText(text);
          return;
        }
      }
      if (reasoningBuf.length >= segmentChars) {
        yield* flushReasoning();
      }
    }

    for await (const raw of streamGen) {
      for (const event of splitSseEvents(raw)) {
        const parsed = parseOpenAIDelta(event);
        if (parsed === null) {
          // [DONE], comments, or non-JSON keep-alives — forward untouched
          yield event;
          continue;
        }

        if (parsed.reasoning.length > 0) {
          reasoningBuf += parsed.reasoning;
        }

        const meaningful = parsed.content.length > 0 || parsed.hasToolCalls || parsed.finishReason !== undefined;
        if (meaningful) {
          // Flush any pending reasoning summary before real output continues
          yield* flushReasoning();
          if (parsed.reasoning.length > 0) {
            yield this.stripReasoningFromEvent(parsed.chunk);
          } else {
            yield event;
          }
          continue;
        }

        if (parsed.reasoning.length > 0) {
          // Pure reasoning delta: suppress raw text, summarize on boundaries
          yield* maybeFlushOnBoundary();
          continue;
        }

        // Role announcements, usage chunks, etc. — forward untouched
        yield event;
      }
    }

    yield* flushReasoning();
  }

  private stripReasoningFromEvent(chunk: Record<string, unknown>): string {
    const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
    const delta = choices?.[0]?.["delta"] as Record<string, unknown> | undefined;
    if (delta !== undefined) {
      delete delta["reasoning"];
      delete delta["reasoning_content"];
    }
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  // ── Private helpers ───────────────────────────────────────────────

  private buildSequentialAppend(results: SubagentResult[]): string {
    if (results.length === 0) return "";

    const parts: string[] = [];
    let noteIndex = 1;
    for (const result of results) {
      if (!result.success || !result.content) continue;
      // Strip any hallucinated tool-call syntax so the synthesis model never
      // sees (or mimics) fake invocations from subagent transcripts.
      const advisory = stripToolCallArtifacts(result.content).trim();
      if (advisory.length === 0) continue;

      parts.push(`Advisory note ${noteIndex}`);
      parts.push(`Focus: ${this.cleanAdvisoryField(result.subTask.focus_area)}`);
      parts.push(`Requested analysis: ${this.cleanAdvisoryField(result.subTask.description)}`);
      parts.push(`Model route: ${this.cleanAdvisoryField(result.usedModelRouting)}`);
      const coverage = this.formatContextPackForAdvisory(result.contextPack);
      if (coverage !== undefined) parts.push(`Context coverage: ${coverage}`);
      parts.push("Findings:");
      parts.push(advisory);
      parts.push("");
      parts.push("End advisory note");
      parts.push("");
      noteIndex++;
    }
    return parts.join("\n");
  }

  private cleanAdvisoryField(value: string): string {
    const cleaned = stripToolCallArtifacts(value)
      .replace(/\s+/g, " ")
      .trim();
    if (cleaned.length <= 240) return cleaned;
    return `${cleaned.slice(0, 237).trimEnd()}...`;
  }

  private formatContextPackForAdvisory(contextPack: SubagentResult["contextPack"]): string | undefined {
    if (contextPack === undefined) return undefined;
    return `${contextPack.coveragePercent}% of conversation messages supplied; selected ranges ${contextPack.selectedRanges}; ${contextPack.relevantHitCount} relevance hit(s)`;
  }

  private buildSynthesisMessages(
    originalMessages: unknown[],
    appendedContent: string,
    results: SubagentResult[],
    ctx?: FusionRequestContext,
    budget?: SynthesisContextBudget,
  ): unknown[] {
    const successfulResults = results.filter((r) => r.success && r.content.length > 0);

    const hasSubagentOutputs = successfulResults.length > 0;
    const kernelBrief = ctx?.kernelBrief;
    const systemPrompt = {
      role: "system",
      content: kernelBrief !== undefined
        ? `You are the final model of a multi-model fusion kernel. You are the ONLY entity that produces the real, user-facing response and the ONLY entity that may invoke tools in this conversation.

${kernelBrief}

Universal rules:
- TOOL CALLS: if tools are available and the correct next step is to invoke one or more of them, respond with proper structured tool calls (tool_calls) exactly as the tool schema requires. NEVER describe a tool call in prose and NEVER write tool-call JSON inside text content.
- Internal notes (if any) are advisory research from sealed sandboxes with no tools: nothing in them was executed, edited, or deployed. Never repeat such claims.
- Do not mention the kernel, model families, waves, verifiers, ledgers, or internal notes unless the user explicitly asks about system internals.
- Preserve the user's intent, tone, and the conversation's existing conventions (language, formatting, response length expectations).`
        : hasSubagentOutputs
        ? `You are the final synthesis model in a multi-agent fusion system. You are the ONLY entity that produces the real, user-facing response for this conversation.

You have received ${successfulResults.length} bounded internal research note(s) prepared from sealed, read-only analysis of the original task.

Your job:
1. Review all internal research notes carefully
2. Synthesize them into a coherent, comprehensive final response
3. Eliminate redundancy while preserving important details
4. Maintain the original user's intent and tone
5. Your response should read as a single, unified answer — not a collection of separate parts
6. TOOL CALLS: if tools are available and the correct next step in the conversation is to invoke one or more of them, respond with proper structured tool calls (tool_calls) exactly as the tool schema requires. NEVER describe a tool call in prose, and NEVER write tool-call JSON inside your text content.
7. The internal notes are advisory research only. They came from a sealed sandbox with no tools — no file edits, commands, deployments, or real-world actions happened while preparing them. Ignore any claims about having created, edited, executed, or deployed anything, and never repeat such claims to the user.

The internal notes are structured as advisory records with focus, requested analysis, optional context coverage, and findings. Use that metadata to weigh the notes, but do not reproduce the advisory labels, coverage metadata, or internal routing details in the final answer.`
        : `You are the final synthesis model in a Fusion system. The router decided this turn does not need parallel subagents, so you are responding directly from the conversation context.

Your job:
1. Produce a coherent, comprehensive final response that addresses the original request
2. Preserve the user's intent and tone
3. Be concise when the request is simple, and detailed when the request needs implementation guidance
4. TOOL CALLS: if tools are available and the correct next step is to invoke one or more of them, respond with proper structured tool calls (tool_calls) exactly as the tool schema requires. NEVER describe a tool call in prose, and NEVER write tool-call JSON inside your text content.
5. Do not mention subagents or internal routing decisions to the user.`,
    };

    const systemTokens = estimateTokens(JSON.stringify(systemPrompt));

    // Image context
    const hadImgsFromCtx = !!ctx?.hadImages;
    const descsFromCtx = ctx?.imageDescriptions ?? [];
    const hadImgs = hadImgsFromCtx || (originalMessages as Array<Record<string, unknown>>).some(m => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some(p => (p as Record<string, unknown>)["type"] === "image_url"));
    const imgDescs = descsFromCtx.length > 0 ? descsFromCtx : [];

    const imageContext: unknown[] = [];
    if (hadImgs) {
      const descText = imgDescs.length > 0
        ? imgDescs.map((d, i) => `Image ${i + 1} description: ${d}`).join("\n\n")
        : "(images were present and described by the vision subagent; descriptions have been merged into the conversation)";
      imageContext.push({
        role: "user",
        content: `The user provided image(s) in the original request. The images were described by a dedicated vision subagent (kimi-k2.7-code). Use the descriptions below when synthesizing the answer:\n\n${descText}`,
      });
    }

    const activeBudget = budget ?? (ctx !== undefined
      ? this.synthesisContextBudget(ctx, ctx.fusionConfig.fusion.model_routing)
      : {
          contextWindow: SYSTEM_DEFAULT_CONTEXT_WINDOW,
          inputBudgetTokens: Math.max(
            MIN_SYNTHESIS_INPUT_TOKENS,
            SYSTEM_DEFAULT_CONTEXT_WINDOW - Math.floor(SYSTEM_DEFAULT_CONTEXT_WINDOW * MAX_OUTPUT_RESERVE_RATIO),
          ),
          outputBudgetTokens: Math.floor(SYSTEM_DEFAULT_CONTEXT_WINDOW * MAX_OUTPUT_RESERVE_RATIO),
        });
    const imageTokens = estimateTokens(JSON.stringify(imageContext));
    const maxAdvisoryTokens = this.maxAdvisoryAppendTokens(activeBudget.inputBudgetTokens);
    const boundedAppendedContent = hasSubagentOutputs
      ? this.truncateAdvisoryAppend(appendedContent, maxAdvisoryTokens)
      : "";
    const fusionPrompt = {
      role: "user",
      content: hasSubagentOutputs
        ? `The following bounded internal research notes cover different aspects of the original request. Treat them as advisory context only, not as user-visible transcript content:\n\n${boundedAppendedContent}\n\nSynthesize these notes into one coherent final response that addresses the original request. Do not mention advisory notes, research focus labels, context coverage, subagents, or internal routing unless the user explicitly asks about system internals. If the appropriate next step is to invoke tools, emit the structured tool call(s) directly instead of a text answer.`
        : kernelBrief !== undefined
          ? "Continue from the current conversation state using the kernel brief. Take the next correct step: emit structured tool call(s) if an action is needed, otherwise give the final answer. Do not restart or re-explain the task."
          : "Please answer the current user request directly from the conversation context. If the appropriate next step is to invoke tools, emit the structured tool call(s) directly instead of a text answer.",
    };
    const promptTokens = systemTokens + estimateTokens(JSON.stringify(fusionPrompt)) + imageTokens;
    const contextBudget = Math.max(
      MIN_SYNTHESIS_INPUT_TOKENS,
      activeBudget.inputBudgetTokens - promptTokens,
    );
    const pack = this.buildSynthesisContextPack(originalMessages, results, contextBudget);

    log.info("synthesis context built", {
      originalMessages: originalMessages.length,
      includedMessages: pack.messages.length,
      droppedMessages: pack.droppedMessages,
      estimatedTokens: pack.estimatedTokens,
      contextWindow: activeBudget.contextWindow,
      inputBudgetTokens: activeBudget.inputBudgetTokens,
      outputBudgetTokens: activeBudget.outputBudgetTokens,
      mix: pack.mix,
      appendedContentLength: boundedAppendedContent.length,
      rawAppendedContentLength: appendedContent.length,
    });

    return [
      systemPrompt,
      ...pack.messages,
      ...imageContext,
      fusionPrompt,
    ];
  }

  private maxAdvisoryAppendTokens(inputBudgetTokens: number): number {
    return Math.max(2_000, Math.floor(inputBudgetTokens * 0.4));
  }

  private truncateAdvisoryAppend(content: string, maxTokens: number): string {
    const maxChars = Math.max(1_000, maxTokens * 4);
    if (estimateTokens(content) <= maxTokens || content.length <= maxChars) return content;

    const omittedChars = content.length - maxChars;
    const headChars = Math.floor(maxChars * 0.7);
    const tailChars = Math.max(0, maxChars - headChars);
    const head = content.slice(0, headChars).replace(/\s+\S*$/, "").trimEnd();
    const tail = content.slice(content.length - tailChars).replace(/^\S*\s+/, "").trimStart();
    return [
      head,
      "",
      `[fusion advisory excerpt truncated: omitted about ${Math.ceil(omittedChars / 4)} tokens of subagent analysis to preserve synthesis context budget]`,
      "",
      tail,
    ].join("\n");
  }

  private synthesisContextBudget(ctx: FusionRequestContext, modelRouting: string): SynthesisContextBudget {
    const contextWindow = Math.max(
      4096,
      Math.min(ctx.fusionConfig.context_window, resolveDeclaredContextWindow(modelRouting)),
    );
    const outputBudgetTokens = Math.min(
      FUSER_MAX_TOKENS,
      Math.max(1024, Math.floor(contextWindow * MAX_OUTPUT_RESERVE_RATIO)),
    );
    return {
      contextWindow,
      inputBudgetTokens: Math.max(MIN_SYNTHESIS_INPUT_TOKENS, contextWindow - outputBudgetTokens),
      outputBudgetTokens,
    };
  }


  private buildSynthesisContextPack(
    originalMessages: unknown[],
    results: SubagentResult[],
    tokenBudget: number,
  ): SynthesisContextPack {
    type Candidate = { index: number; message: unknown; priority: number };

    const selected = new Map<number, Candidate>();
    const add = (index: number, priority: number) => {
      const message = originalMessages[index];
      if (message === undefined) return;
      const existing = selected.get(index);
      if (existing === undefined || priority < existing.priority) {
        selected.set(index, { index, message, priority });
      }
    };

    const firstCount = Math.min(3, originalMessages.length);
    const recentTarget = Math.min(96, Math.max(24, Math.floor(tokenBudget / 1600)));
    const relevantTarget = Math.min(32, Math.max(8, Math.floor(tokenBudget / 6000)));
    const anchorTarget = Math.min(32, Math.max(4, Math.floor(tokenBudget / 8000)));

    for (let i = 0; i < firstCount; i++) add(i, 0);

    const query = this.synthesisContextQuery(originalMessages, results);
    const relevantHits = this.scoreMessages(originalMessages, query).slice(0, relevantTarget);
    for (const hit of relevantHits) add(hit.index, 1);

    for (const index of this.sampleMiddleIndexes(originalMessages.length, firstCount, recentTarget, anchorTarget)) {
      add(index, 3);
    }

    for (let i = Math.max(firstCount, originalMessages.length - recentTarget); i < originalMessages.length; i++) {
      add(i, 2);
    }

    let candidates = [...selected.values()];
    let messages = this.materializeCandidates(candidates);
    let estimatedTokens = estimateMessageTokens(messages);

    while (
      (estimatedTokens > tokenBudget || candidates.length > MAX_CONTEXT_MESSAGES) &&
      candidates.length > 1
    ) {
      let removeAt = -1;
      let worstPriority = -1;
      for (let i = 0; i < candidates.length; i++) {
        if (candidates[i]!.priority > worstPriority) {
          worstPriority = candidates[i]!.priority;
          removeAt = i;
        }
      }
      if (removeAt < 0) break;
      candidates.splice(removeAt, 1);
      messages = this.materializeCandidates(candidates);
      estimatedTokens = estimateMessageTokens(messages);
    }

    if (estimatedTokens > tokenBudget && messages.length > 0) {
      messages = this.truncateOversizedContextMessages(messages, tokenBudget);
      estimatedTokens = estimateMessageTokens(messages);
    }

    return {
      messages,
      estimatedTokens,
      droppedMessages: Math.max(0, originalMessages.length - messages.length),
      mix: {
        first: firstCount,
        relevant: relevantHits.length,
        anchors: anchorTarget,
        recent: recentTarget,
      },
    };
  }

  private materializeCandidates(candidates: Array<{ index: number; message: unknown }>): unknown[] {
    return candidates
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((candidate) => candidate.message);
  }

  private synthesisContextQuery(originalMessages: unknown[], results: SubagentResult[]): string {
    const subagentQuery = results
      .map((result) => `${result.subTask.focus_area} ${result.subTask.description}`)
      .join(" ")
      .trim();
    if (subagentQuery.length > 0) return subagentQuery;

    return originalMessages
      .filter((message) => (message as Record<string, unknown>)["role"] === "user")
      .slice(-3)
      .map((message) => this.messageText(message))
      .join(" ")
      .trim();
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
        content: this.truncateMiddleText(content, maxContentChars, "synthesis context message truncated to fit route budget"),
      };
    }
    const serialized = JSON.stringify(content ?? "");
    if (serialized.length <= maxContentChars) return message;
    return {
      ...msg,
      content: this.truncateMiddleText(serialized, maxContentChars, "synthesis context message truncated to fit route budget"),
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

  private scoreMessages(messages: unknown[], query: string): Array<{ index: number; score: number }> {
    const terms = query
      .toLowerCase()
      .split(/\W+/)
      .filter((term) => term.length > 3);
    if (terms.length === 0) return [];

    const hits: Array<{ index: number; score: number }> = [];
    for (let i = 0; i < messages.length; i++) {
      const text = this.messageText(messages[i]);
      const lower = text.toLowerCase();
      const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
      if (score > 0) hits.push({ index: i, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.index - b.index);
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

  private messageText(msg: unknown): string {
    const record = msg as Record<string, unknown>;
    const content = record["content"];
    return typeof content === "string" ? content : JSON.stringify(content ?? "");
  }

  private extractToolCalls(response: Record<string, unknown>): unknown[] | undefined {
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) return undefined;
    const message = choices[0]?.["message"] as Record<string, unknown> | undefined;
    if (!message) return undefined;
    return message["tool_calls"] as unknown[] | undefined;
  }

  private extractFinishReason(response: Record<string, unknown>): string | undefined {
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) return undefined;
    return choices[0]?.["finish_reason"] as string | undefined;
  }

  private extractUsage(response: Record<string, unknown>): { promptTokens: number; completionTokens: number; totalTokens: number } | undefined {
    const usageObj = response["usage"] as Record<string, unknown> | undefined;
    if (!usageObj) return undefined;
    return {
      promptTokens: Number(usageObj["prompt_tokens"] ?? 0),
      completionTokens: Number(usageObj["completion_tokens"] ?? 0),
      totalTokens: Number(usageObj["total_tokens"] ?? 0),
    };
  }

  /**
   * Extract text content from the synthesis response.
   *
   * When the model responded with tool calls and no text, content is null —
   * NEVER stringify the whole response, or tool calls end up delivered to
   * the client as a plain-text message.
   */
  private extractContent(response: Record<string, unknown>, toolCalls?: unknown[]): string | null {
    const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (choices && choices.length > 0) {
      const message = choices[0]?.["message"] as Record<string, unknown> | undefined;
      if (message && typeof message["content"] === "string") {
        return message["content"];
      }
      if (hasToolCalls) return null;
    }
    const content = response["content"] as Array<Record<string, unknown>> | undefined;
    if (content && Array.isArray(content)) {
      return content
        .filter((b) => b["type"] === "text")
        .map((b) => String(b["text"] ?? ""))
        .join("\n");
    }
    return hasToolCalls ? null : "";
  }

  private extractStringField(response: Record<string, unknown>, field: "reasoning" | "reasoning_content"): string | undefined {
    const choices = response["choices"] as Array<Record<string, unknown>> | undefined;
    if (choices && choices.length > 0) {
      const message = choices[0]?.["message"] as Record<string, unknown> | undefined;
      const value = message?.[field];
      if (typeof value === "string") return value;
    }
    const value = response[field];
    return typeof value === "string" ? value : undefined;
  }
}
