/**
 * Anthropic-compatible API routes.
 * /v1/messages endpoint with OpenAI-to-Anthropic stream adapter.
 */
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { configLoader } from "../routing/config-loader.ts";
import { FallbackRouter } from "../routing/router.ts";
import { formatAnthropicError } from "../core/error-formatters.ts";
import { RoutingError } from "../types/routing.ts";
import { randomUUID } from "crypto";

const app = new Hono();

// ── OpenAI -> Anthropic Stream Adapter ────────────────────────────
class OpenAIStreamAdapter {
  private requestedModel: string;
  private messageId: string;
  private responseContent: Record<string, any>[] = [];
  private activeBlocks: Map<number, Record<string, any>> = new Map();
  private currentTextIndex: number | null = null;
  private nextBlockIndex = 0;
  private toolState: Map<string, Record<string, any>> = new Map();
  private finishReason: string | null = null;
  private usage: Record<string, any> | null = null;

  constructor(requestedModel: string) {
    this.requestedModel = requestedModel;
    this.messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
  }

  private sse(event: string, payload: Record<string, any>): string {
    return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  *start(): Generator<string> {
    yield this.sse("message_start", {
      type: "message_start",
      message: {
        id: this.messageId, type: "message", role: "assistant",
        model: this.requestedModel, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
  }

  *processChunk(rawChunk: string): Generator<string> {
    for (const line of rawChunk.split("\n")) {
      const stripped = line.trim();
      if (!stripped || !stripped.startsWith("data:")) continue;
      const payload = stripped.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        yield* this.handleOpenAIObject(obj);
      } catch {}
    }
  }

  private *handleOpenAIObject(obj: Record<string, any>): Generator<string> {
    if (obj.usage) this.usage = obj.usage;
    const choices = obj.choices;
    if (!Array.isArray(choices) || choices.length === 0) return;
    const choice = choices[0];
    const delta = choice.delta || {};
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    if (delta) yield* this.handleDelta(delta);
  }

  private *handleDelta(delta: Record<string, any>): Generator<string> {
    const content = delta.content;
    if (typeof content === "string") yield* this.emitText(content);
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === "text") yield* this.emitText(part.text || "");
      }
    }

    if (delta.tool_calls) {
      for (const call of delta.tool_calls) {
        const fn = call.function || {};
        const toolId = call.id || fn.name || `tool_${this.toolState.size}`;
        const name = fn.name || toolId;
        const args = fn.arguments || "";
        const idx = yield* this.ensureToolBlock(toolId, name);
        yield* this.emitToolArgs(toolId, idx, args);
      }
    }
  }

  private *emitText(text: string): Generator<string> {
    if (!text) return;
    const idx = yield* this.ensureTextBlock();
    const block = this.activeBlocks.get(idx);
    if (block) block.text = (block.text || "") + text;
    yield this.sse("content_block_delta", {
      type: "content_block_delta", index: idx,
      delta: { type: "text_delta", text },
    });
  }

  private *ensureTextBlock(): Generator<string, number> {
    if (this.currentTextIndex !== null) return this.currentTextIndex;
    const idx = this.nextBlockIndex++;
    const block = { type: "text", text: "" };
    this.responseContent.push(block);
    this.activeBlocks.set(idx, block);
    this.currentTextIndex = idx;
    yield this.sse("content_block_start", {
      type: "content_block_start", index: idx,
      content_block: { type: "text", text: "" },
    });
    return idx;
  }

  private *ensureToolBlock(toolId: string, toolName: string): Generator<string, number> {
    if (this.toolState.has(toolId)) return this.toolState.get(toolId)!.block_index;
    if (this.currentTextIndex !== null) yield* this.finalizeBlock(this.currentTextIndex);
    const idx = this.nextBlockIndex++;
    const block = { type: "tool_use", id: toolId, name: toolName, input: {} };
    this.responseContent.push(block);
    this.activeBlocks.set(idx, block);
    this.toolState.set(toolId, { block_index: idx, buffer: "", name: toolName });
    yield this.sse("content_block_start", {
      type: "content_block_start", index: idx,
      content_block: { type: "tool_use", id: toolId, name: toolName, input: {} },
    });
    return idx;
  }

  private *emitToolArgs(toolId: string, blockIndex: number, args: string): Generator<string> {
    const state = this.toolState.get(toolId);
    if (!state) return;
    const prev = state.buffer || "";
    const delta = args.startsWith(prev) ? args.slice(prev.length) : args;
    state.buffer = args;
    if (!delta) return;
    yield this.sse("content_block_delta", {
      type: "content_block_delta", index: blockIndex,
      delta: { type: "input_json_delta", partial_json: delta },
    });
  }

  private *finalizeBlock(idx: number): Generator<string> {
    const block = this.activeBlocks.get(idx);
    if (!block) return;
    this.activeBlocks.delete(idx);
    if (block.type === "text" && this.currentTextIndex === idx) this.currentTextIndex = null;
    else if (block.type === "tool_use") {
      const toolId = block.id;
      const state = toolId ? this.toolState.get(toolId) : null;
      if (state?.buffer) {
        try { block.input = JSON.parse(state.buffer); } catch { block.input = { _raw: state.buffer }; }
      }
      if (toolId) this.toolState.delete(toolId);
    }
    yield this.sse("content_block_stop", { type: "content_block_stop", index: idx });
  }

  *finalize(): Generator<string> {
    for (const [, state] of this.toolState) yield* this.finalizeBlock(state.block_index);
    if (this.currentTextIndex !== null) yield* this.finalizeBlock(this.currentTextIndex);
    for (const idx of this.activeBlocks.keys()) yield* this.finalizeBlock(idx);

    const stopMap: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
    const usage = this.usage || {};

    yield this.sse("message_stop", {
      type: "message_stop",
      message: {
        id: this.messageId, type: "message", role: "assistant",
        model: this.requestedModel, content: this.responseContent,
        stop_reason: this.finishReason ? (stopMap[this.finishReason] || "end_turn") : "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: usage.prompt_tokens || 0,
          output_tokens: usage.completion_tokens || 0,
          cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
        },
      },
    });
    yield "data: [DONE]\n\n";
  }
}

// Messages endpoint
app.post("/v1/messages", async (c) => {
  let body: Record<string, any>;
  try { body = await c.req.json(); } catch { return c.json(formatAnthropicError(400, "Invalid JSON body"), 400); }

  const model = body.model;
  if (!model) return c.json(formatAnthropicError(400, "model is required"), 400);

  try { configLoader.loadConfig(model); } catch {
    return c.json(formatAnthropicError(400, `Model '${model}' not found`, "invalid_request_error"), 400);
  }

  const isStream = !!body.stream;
  const router = new FallbackRouter();

  if (isStream) {
    return honoStream(c, async (stream) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      try {
        const gen = await router.callWithFallback(model, body, "anthropic", true);
        const adapter = new OpenAIStreamAdapter(model);
        let isAnthropicNative = false;
        let firstChunkProcessed = false;

        for (const chunk of adapter.start()) await stream.write(chunk);

        for await (const rawChunk of gen) {
          if (!firstChunkProcessed) {
            if (rawChunk.includes("event:") || rawChunk.includes('"type":"message_start"')) {
              isAnthropicNative = true;
            }
            firstChunkProcessed = true;
          }

          if (isAnthropicNative) {
            await stream.write(rawChunk);
          } else {
            for (const converted of adapter.processChunk(rawChunk)) await stream.write(converted);
          }
        }

        if (!isAnthropicNative) {
          for (const chunk of adapter.finalize()) await stream.write(chunk);
        }
      } catch (e: any) {
        const errEvent = { type: "error", error: { type: "routing_error", message: String(e) } };
        await stream.write(`event: error\ndata: ${JSON.stringify(errEvent)}\n\n`);
        await stream.write("data: [DONE]\n\n");
      }
    });
  }

  try {
    const response = await router.callWithFallback(model, body, "anthropic", false);
    response.model = model;
    return c.json(response);
  } catch (e: any) {
    if (e instanceof RoutingError) {
      return c.json(formatAnthropicError(503, `All routes failed: ${e.getErrorSummary()}`, "service_unavailable"), 503);
    }
    return c.json(formatAnthropicError(500, `Error: ${e.message}`), 500);
  }
});

// Token counting (approximate)
app.post("/v1/messages/count_tokens", async (c) => {
  let body: Record<string, any>;
  try { body = await c.req.json(); } catch { return c.json(formatAnthropicError(400, "Invalid JSON"), 400); }

  let totalTokens = 0;
  const approx = (text: string) => Math.max(1, Math.floor(text.length / 4));

  for (const msg of (body.messages || [])) {
    const content = msg.content;
    if (typeof content === "string") totalTokens += approx(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.text) totalTokens += approx(block.text);
      }
    }
  }

  if (body.system) {
    if (typeof body.system === "string") totalTokens += approx(body.system);
    else if (Array.isArray(body.system)) {
      for (const block of body.system) {
        if (block?.text) totalTokens += approx(block.text);
      }
    }
  }

  return c.json({ input_tokens: totalTokens });
});

export default app;
