import { createLogger } from "../observability/logger.ts";
import {
  AbstractProvider,
  type AnthropicCallArgs,
  type OpenAICallArgs,
  type ProviderCallContext,
  type ResponsesCallArgs,
} from "./base.ts";
import { ProviderAPIError, ProviderTimeoutError } from "./errors.ts";
import {
  parseRetryAfterFromErrorBody,
  parseRetryAfterHeader,
  readBodyWithDeadline,
  upstreamFetch,
} from "./upstream-fetch.ts";
import { buildEndpointUrl } from "./provider-helpers.ts";

const log = createLogger("provider.openai");

/**
 * When `true`, the OpenAI provider drops client-supplied `chat_template_kwargs`
 * instead of forwarding them to the upstream. Set
 * `DISABLE_CHAT_TEMPLATE_KWARGS_PASSTHROUGH=1` (or `true`/`yes`/`on`) to opt
 * out of the passthrough; default is to forward.
 */
export function isChatTemplateKwargsPassthroughDisabled(): boolean {
  const raw = process.env["DISABLE_CHAT_TEMPLATE_KWARGS_PASSTHROUGH"];
  if (raw === undefined) return false;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

interface ProviderQuirks {
  isGemini: boolean;
  isCerebras: boolean;
}

/**
 * OpenAI Chat Completions-compatible provider. Covers OpenAI itself plus
 * groq/cerebras/nvidia/chutes/longcat/zai/nahcrof/llama/mistral/cloudflare/openrouter.
 *
 * Gemini/Cerebras quirks are inlined here because the provider's capability
 * matrix is tied to the provider name, not the SDK.
 */
export class OpenAIProvider extends AbstractProvider {
  private quirks(): ProviderQuirks {
    return {
      isGemini: this.providerName === "gemini",
      isCerebras: this.providerName === "cerebras",
    };
  }

  protected openAIRequestHeaders(
    ctx: ProviderCallContext,
    accept: string,
  ): Record<string, string> {
    return {
      ...this.authHeaders(ctx),
      ...(ctx.extraHeaders ?? {}),
      "Content-Type": "application/json",
      Accept: accept,
    };
  }

  async callOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    const payload = this.buildPayload({ ...args, stream: false });
    const url = this.endpointUrl(ctx);
    log.debug("upstream request", {
      provider: this.providerName,
      model: args.model,
      messageCount: Array.isArray(args.messages) ? args.messages.length : 0,
    });
    return await this.fetchJson(
      url,
      {
        method: "POST",
        headers: this.openAIRequestHeaders(ctx, "application/json"),
        body: JSON.stringify(payload),
      },
      ctx,
    );
  }

  /** Native Responses API transport for routes configured with responses wire format. */
  async callResponses(
    args: ResponsesCallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    const url = buildEndpointUrl(this.config, ctx.baseUrlOverride, "responses");
    return await this.fetchJson(
      url,
      {
        method: "POST",
        headers: this.openAIRequestHeaders(ctx, "application/json"),
        body: JSON.stringify(this.buildResponsesPayload({ ...args, stream: false })),
      },
      ctx,
    );
  }

  /** Native Responses SSE transport for routes configured with responses wire format. */
  async *streamResponses(
    args: ResponsesCallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown> {
    const url = buildEndpointUrl(this.config, ctx.baseUrlOverride, "responses_streaming");
    const timeoutMs = Math.max(1, ctx.timeoutSeconds * 1000);
    const connController = new AbortController();
    const onCallerAbort = () => connController.abort();
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) connController.abort();
      else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      const response = await upstreamFetch(url, {
        method: "POST",
        headers: this.openAIRequestHeaders(ctx, "text/event-stream"),
        body: JSON.stringify(this.buildResponsesPayload({ ...args, stream: true })),
        proxy: ctx.egressProxyUrl,
        timeoutMs,
        signal: connController.signal,
      });
      if (response.status >= 400) {
        const body = await this.readErrorBody(response);
        throw new ProviderAPIError(
          `${this.providerName} Responses API error ${response.status}: ${body.slice(0, 500)}`,
          response.status,
          {
            body,
            provider: this.providerName,
            retryAfterSeconds:
              parseRetryAfterHeader(response) ?? parseRetryAfterFromErrorBody(body),
          },
        );
      }
      if (response.body === null) {
        throw new ProviderAPIError(
          `${this.providerName} Responses streaming response body was empty`,
          502,
          { provider: this.providerName },
        );
      }
      let eventLines: string[] = [];
      for await (const line of readSSELines(response.body)) {
        if (line.length === 0) {
          if (eventLines.length > 0) {
            yield `${eventLines.join("\n")}\n\n`;
            eventLines = [];
          }
        } else {
          eventLines.push(line);
        }
      }
      if (eventLines.length > 0) {
        yield `${eventLines.join("\n")}\n\n`;
      }
    } finally {
      ctx.signal?.removeEventListener("abort", onCallerAbort);
      connController.abort();
    }
  }

  async *streamOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown> {
    const payload = this.buildPayload({ ...args, stream: true });
    const url = this.endpointUrl(ctx, "streaming");
    const timeoutMs = Math.max(1, ctx.timeoutSeconds * 1000);

    // This generator owns the upstream connection. Streaming consumers
    // routinely exit before the body is drained (returning on `data: [DONE]`,
    // breaking early, stream errors) — and in Bun, aborting the fetch signal
    // is the ONLY reliable way to release a partially-consumed body's
    // connection. reader.cancel()/body.cancel() leave the socket stranded
    // until GC, and with a 256-per-host connection cap, leaked sockets
    // eventually starve the pool and every new request to that host queues
    // forever (observed as a total pipeline freeze under summarizer load).
    const connController = new AbortController();
    const onCallerAbort = () => connController.abort();
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) connController.abort();
      else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    try {
      yield* this.streamOpenAIInner(args, ctx, { payload, url, timeoutMs, signal: connController.signal });
    } finally {
      ctx.signal?.removeEventListener("abort", onCallerAbort);
      // Hard-release the connection. No-op if the response completed and the
      // socket was already returned to the pool.
      connController.abort();
    }
  }

  private async *streamOpenAIInner(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
    req: { payload: Record<string, unknown>; url: string; timeoutMs: number; signal: AbortSignal },
  ): AsyncGenerator<string, void, unknown> {
    const { payload, url, timeoutMs, signal } = req;
    const response = await upstreamFetch(url, {
      method: "POST",
      headers: this.openAIRequestHeaders(ctx, "text/event-stream"),
      body: JSON.stringify(payload),
      proxy: ctx.egressProxyUrl,
      timeoutMs,
      signal,
    });

    if (response.status >= 400) {
      const body = await this.readErrorBody(response);
      throw new ProviderAPIError(
        `${this.providerName} API error ${response.status}: ${body.slice(0, 500)}`,
        response.status,
        {
          body,
          provider: this.providerName,
          retryAfterSeconds:
            parseRetryAfterHeader(response) ?? parseRetryAfterFromErrorBody(body),
        },
      );
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isSSE = contentType.includes("text/event-stream");

    if (!isSSE) {
      // Non-SSE fallback: convert body to a single SSE chunk.
      let data: Record<string, unknown> = {};
      try {
        data = await readBodyWithDeadline(
          response,
          () => response.json() as Promise<Record<string, unknown>>,
          timeoutMs,
        );
      } catch {
        // leave as empty dict
      }
      yield* synthesizeSingleChunkStream(data, args.model);
      return;
    }

    if (response.body === null) {
      throw new ProviderAPIError(
        `${this.providerName} streaming response body was empty`,
        502,
        { provider: this.providerName },
      );
    }

    const streamId = `chatcmpl-${Date.now()}`;
    const normalizeState = createStreamNormalizeState();
    const bufferPartialToolCalls = ctx.bufferPartialToolCalls === true;
    let bufferedToolCallChunks: string[] = [];
    const flushBufferedToolCallChunks = function* () {
      for (const chunk of bufferedToolCallChunks) yield chunk;
      bufferedToolCallChunks = [];
    };
    for await (const line of readSSELines(response.body)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed === "data:") continue;
      if (trimmed === "data: [DONE]") {
        if (bufferPartialToolCalls) yield* flushBufferedToolCallChunks();
        yield "data: [DONE]\n\n";
        return;
      }
      if (!trimmed.startsWith("data:")) {
        if (/error|ResponseStreamResult/i.test(trimmed)) {
          throw new ProviderAPIError(
            `Stream error from ${this.providerName}: ${trimmed.slice(0, 200)}`,
            500,
            { body: trimmed, provider: this.providerName },
          );
        }
        yield `${line}\n\n`;
        continue;
      }
      const jsonStr = trimmed.slice(5).trim();
      if (jsonStr.length === 0) continue;
      if (jsonStr === "[DONE]") {
        if (bufferPartialToolCalls) yield* flushBufferedToolCallChunks();
        yield "data: [DONE]\n\n";
        return;
      }
      try {
        const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed
        ) {
          const errInfo = (parsed["error"] ?? {}) as Record<string, unknown>;
          const message =
            typeof errInfo["message"] === "string"
              ? errInfo["message"]
              : JSON.stringify(parsed);
          throw new ProviderAPIError(
            `Stream error from ${this.providerName}: ${message}`,
            (errInfo["code"] as number) ?? 500,
            { body: jsonStr, provider: this.providerName },
          );
        }
        const normalized = normalizeStreamChunk(parsed, args.model, streamId, normalizeState);
        const output = `data: ${JSON.stringify(normalized)}\n\n`;
        if (bufferPartialToolCalls && streamChunkHasToolCalls(normalized)) {
          bufferedToolCallChunks.push(output);
          if (streamChunkFinishesToolCalls(normalized)) {
            yield* flushBufferedToolCallChunks();
          }
          continue;
        }
        if (bufferPartialToolCalls && bufferedToolCallChunks.length > 0) {
          yield* flushBufferedToolCallChunks();
        }
        yield output;
      } catch (err) {
        if (err instanceof ProviderAPIError) throw err;
        if (/error|ResponseStreamResult/i.test(jsonStr)) {
          throw new ProviderAPIError(
            `Stream error from ${this.providerName}: ${jsonStr.slice(0, 200)}`,
            500,
            { body: jsonStr, provider: this.providerName },
          );
        }
        log.warn("skipped malformed SSE chunk", {
          provider: this.providerName,
          err: String(err),
          preview: jsonStr.slice(0, 80),
        });
      }
    }
    if (bufferPartialToolCalls && bufferedToolCallChunks.length > 0) {
      throw new ProviderAPIError(
        `${this.providerName} stream ended before completing a tool call`,
        502,
        { provider: this.providerName },
      );
    }
  }

  async callAnthropic(
    _args: AnthropicCallArgs,
    _ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    throw new Error(
      `${this.providerName} is an OpenAI-compatible provider; call callOpenAI instead`,
    );
  }

  private buildPayload(args: OpenAICallArgs): Record<string, unknown> {
    const { isGemini, isCerebras } = this.quirks();

    const messages = isGemini ? sanitizeGeminiMessages(args.messages) : args.messages;
    const payload: Record<string, unknown> = {
      model: args.model,
      messages,
      stream: args.stream ?? false,
    };

    if (args.temperature !== undefined) {
      if (!isGemini || args.temperature !== 1.0) {
        payload["temperature"] = args.temperature;
      }
    }
    if (args.top_p !== undefined) {
      if (!isGemini || args.top_p !== 1.0) {
        payload["top_p"] = args.top_p;
      }
    }
    if (args.n !== undefined && !isGemini && !isCerebras) payload["n"] = args.n;
    if (args.stop !== undefined && !isGemini) payload["stop"] = args.stop;
    if (args.max_tokens !== undefined) {
      if (isCerebras) payload["max_completion_tokens"] = args.max_tokens;
      else payload["max_tokens"] = args.max_tokens;
    } else if (args.max_completion_tokens !== undefined && !isGemini) {
      payload["max_completion_tokens"] = args.max_completion_tokens;
    }
    if (
      args.presence_penalty !== undefined &&
      !isGemini &&
      !isCerebras
    ) {
      payload["presence_penalty"] = args.presence_penalty;
    }
    if (args.frequency_penalty !== undefined && !isGemini && !isCerebras) {
      payload["frequency_penalty"] = args.frequency_penalty;
    }
    if (args.logit_bias !== undefined && !isGemini && !isCerebras) {
      payload["logit_bias"] = args.logit_bias;
    }
    if (args.user !== undefined && !isGemini) payload["user"] = args.user;
    if (args.tools !== undefined) payload["tools"] = args.tools;
    if (args.tool_choice !== undefined) payload["tool_choice"] = args.tool_choice;
    if (args.response_format !== undefined && !isGemini) {
      payload["response_format"] = args.response_format;
    }
    if (args.reasoning !== undefined && !isGemini) {
      payload["reasoning"] = args.reasoning;
    }
    if (
      args.chat_template_kwargs !== undefined &&
      !isChatTemplateKwargsPassthroughDisabled()
    ) {
      payload["chat_template_kwargs"] = args.chat_template_kwargs;
    }

    return payload;
  }

  private buildResponsesPayload(args: ResponsesCallArgs): Record<string, unknown> {
    // Responses has a deliberately extensible request shape. Forward the
    // complete validated request so newer official fields (background,
    // conversation, prompt-cache options, tool-specific options, etc.) are
    // not silently discarded by the transport.
    return { ...args, model: args.model };
  }
}

function sanitizeGeminiMessages(messages: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) {
      out.push(msg);
      continue;
    }
    const m = msg as Record<string, unknown>;
    const clean: Record<string, unknown> = {
      role: m["role"],
      content: m["content"],
    };
    if (m["tool_calls"] !== undefined) clean["tool_calls"] = m["tool_calls"];
    if (m["tool_call_id"] !== undefined) clean["tool_call_id"] = m["tool_call_id"];
    if (m["name"] !== undefined) clean["name"] = m["name"];
    out.push(clean);
  }
  return out;
}

async function* synthesizeSingleChunkStream(
  data: Record<string, unknown>,
  model: string,
): AsyncGenerator<string, void, unknown> {
  let content = "";
  let toolCalls: unknown = undefined;
  let reasoning: unknown = undefined;
  let reasoningContent: unknown = undefined;
  const choices = data["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const msg = (first["message"] as Record<string, unknown>) ?? {};
    const rawContent = msg["content"];
    if (typeof rawContent === "string") content = rawContent;
    if (msg["tool_calls"] !== undefined) toolCalls = msg["tool_calls"];
    if (msg["reasoning"] !== undefined) reasoning = msg["reasoning"];
    if (msg["reasoning_content"] !== undefined) {
      reasoningContent = msg["reasoning_content"];
    }
  }
  const delta: Record<string, unknown> = { role: "assistant", content };
  if (Array.isArray(toolCalls)) delta["tool_calls"] = normalizeStreamToolCalls(toolCalls);
  if (reasoning !== undefined) delta["reasoning"] = reasoning;
  if (reasoningContent !== undefined) delta["reasoning_content"] = reasoningContent;
  const now = Math.floor(Date.now() / 1000);
  const chunk = {
    id: `chatcmpl-${now}`,
    object: "chat.completion.chunk",
    created: now,
    model,
    choices: [{ index: 0, delta }],
  };
  yield `data: ${JSON.stringify(chunk)}\n\n`;
  yield "data: [DONE]\n\n";
}

/**
 * Max silence between SSE chunks before the stream is declared dead. Covers
 * upstreams that stall mid-body without closing the socket — connection
 * timeouts only protect the header phase, and a silently dead stream would
 * otherwise hang its consumer forever.
 */
const SSE_INACTIVITY_TIMEOUT_MS = 120_000;

async function* readSSELines(
  stream: ReadableStream<Uint8Array>,
  inactivityTimeoutMs: number = SSE_INACTIVITY_TIMEOUT_MS,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  const readWithInactivityGuard = async (): Promise<{ value?: Uint8Array; done: boolean }> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // Reject BEFORE cancelling: cancel() resolves the pending read()
            // as { done: true }, which would win the race and make the stall
            // look like a clean end-of-stream.
            reject(
              new ProviderTimeoutError(
                `SSE stream stalled; no data for ${inactivityTimeoutMs}ms`,
                inactivityTimeoutMs,
              ),
            );
            void reader.cancel().catch(() => {});
          }, inactivityTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  try {
    for (;;) {
      const { value, done } = await readWithInactivityGuard();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        let line = buffer.slice(0, newlineIdx);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        buffer = buffer.slice(newlineIdx + 1);
        yield line;
        newlineIdx = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) {
      const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
      yield line;
    }
  } finally {
    // Cancel, don't just release: this generator frequently exits before the
    // body is fully drained (e.g. returning on `data: [DONE]` before the
    // terminal chunk, or a consumer breaking early). A released-but-uncancelled
    // body strands the connection — it can't be reused and isn't closed until
    // GC. Bun caps concurrent connections per host (256); leaked streams
    // exhaust the pool and every subsequent fetch to that host queues forever.
    try {
      void reader.cancel().catch(() => {});
    } catch {
      // reader may already be released/errored — nothing to cancel
    }
    reader.releaseLock();
  }
}

export { readSSELines };

function normalizeStreamChunk(
  chunk: Record<string, unknown>,
  model: string,
  fallbackId: string,
  state: StreamNormalizeState,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...chunk };
  // The OpenAI streaming contract uses ONE id and ONE created timestamp for
  // every chunk of a completion. Some upstreams (nahcrof) mint a fresh id per
  // chunk, which strict clients may interpret as thousands of separate
  // completions — adopt the first chunk's identity and pin it for the stream.
  if (state.canonicalId === undefined) {
    state.canonicalId =
      typeof normalized["id"] === "string" && normalized["id"].length > 0
        ? normalized["id"]
        : fallbackId;
  }
  normalized["id"] = state.canonicalId;
  if (typeof normalized["object"] !== "string" || normalized["object"].length === 0) {
    normalized["object"] = "chat.completion.chunk";
  }
  if (state.canonicalCreated === undefined) {
    state.canonicalCreated =
      typeof normalized["created"] === "number" && Number.isFinite(normalized["created"])
        ? normalized["created"]
        : Math.floor(Date.now() / 1000);
  }
  normalized["created"] = state.canonicalCreated;
  if (typeof normalized["model"] !== "string" || normalized["model"].length === 0) {
    normalized["model"] = model;
  }
  if (Array.isArray(normalized["choices"])) {
    normalized["choices"] = normalized["choices"].map((choice, index) =>
      normalizeStreamChoice(choice, index, state),
    );
  }
  return normalized;
}

function streamChunkHasToolCalls(chunk: Record<string, unknown>): boolean {
  const choices = chunk["choices"];
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return false;
    const choiceObj = choice as Record<string, unknown>;
    if (choiceObj["finish_reason"] === "tool_calls") return true;
    const delta = choiceObj["delta"];
    if (typeof delta !== "object" || delta === null || Array.isArray(delta)) return false;
    return Array.isArray((delta as Record<string, unknown>)["tool_calls"]);
  });
}

function streamChunkFinishesToolCalls(chunk: Record<string, unknown>): boolean {
  const choices = chunk["choices"];
  if (!Array.isArray(choices)) return false;
  return choices.some((choice) => {
    if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return false;
    return (choice as Record<string, unknown>)["finish_reason"] === "tool_calls";
  });
}

interface ToolCallSlot {
  /** Index emitted downstream for this logical tool call. */
  outIndex: number;
  /** Stable id emitted downstream for this logical tool call. */
  id: string;
}

interface StreamNormalizeState {
  /** Provider slot key (`choice:index`) -> current logical tool call. */
  slots: Map<string, ToolCallSlot>;
  /** Next unused downstream tool-call index, per choice. */
  nextOutIndex: Map<number, number>;
  /** Canonical completion id adopted from the first chunk (spec: one id per stream). */
  canonicalId?: string;
  /** Canonical created timestamp adopted from the first chunk. */
  canonicalCreated?: number;
  /** Choices whose delta already carried `role` (spec: role on first delta only). */
  roleEmitted: Set<number>;
}

function createStreamNormalizeState(): StreamNormalizeState {
  return { slots: new Map(), nextOutIndex: new Map(), roleEmitted: new Set() };
}

function normalizeStreamChoice(
  choice: unknown,
  index: number,
  state: StreamNormalizeState,
): unknown {
  if (typeof choice !== "object" || choice === null || Array.isArray(choice)) return choice;
  const normalized: Record<string, unknown> = { ...(choice as Record<string, unknown>) };
  if (typeof normalized["index"] !== "number" || !Number.isFinite(normalized["index"])) {
    normalized["index"] = index;
  }
  const delta = normalized["delta"];
  if (typeof delta === "object" && delta !== null && !Array.isArray(delta)) {
    normalized["delta"] = normalizeStreamDelta(delta as Record<string, unknown>, index, state);
  } else if (delta !== undefined) {
    normalized["delta"] = {};
  }
  // OpenAI includes `finish_reason` (null until the terminal chunk) on every
  // streamed choice; some upstreams omit the key entirely on non-final chunks.
  if (!("finish_reason" in normalized)) {
    normalized["finish_reason"] = null;
  }
  return normalized;
}

function normalizeStreamDelta(
  delta: Record<string, unknown>,
  choiceIndex: number,
  state: StreamNormalizeState,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...delta };
  // OpenAI sends `role` exactly once, on the first delta of each choice. Some
  // upstreams (nahcrof) repeat `role: "assistant"` on every chunk, which
  // strict accumulators can misread as the start of a brand-new assistant
  // message mid-stream.
  const role = normalized["role"];
  if (typeof role === "string" && role.length > 0) {
    if (state.roleEmitted.has(choiceIndex)) {
      delete normalized["role"];
    } else {
      state.roleEmitted.add(choiceIndex);
    }
  } else if ("role" in normalized) {
    delete normalized["role"];
  }
  const content = normalized["content"];
  if (content !== undefined && typeof content !== "string") {
    normalized["content"] = "";
  }
  // Canonical deltas only carry `content` when there is content to add (or on
  // the role-bearing first delta). Upstreams that stamp `content: ""` onto
  // every tool-call/reasoning chunk produce thousands of empty text parts.
  if (normalized["content"] === "" && !("role" in normalized)) {
    delete normalized["content"];
  }
  // Coerce malformed (non-string) reasoning fields, but otherwise pass reasoning
  // deltas through untouched: clients accumulate them into a single thinking
  // block. Rewriting or duplicating them into "content" fragments the reasoning
  // stream into one thinking section per chunk in clients like OpenCode.
  for (const field of ["reasoning", "reasoning_content"]) {
    if (normalized[field] !== undefined && typeof normalized[field] !== "string") {
      normalized[field] = "";
    }
  }
  if (Array.isArray(normalized["tool_calls"])) {
    normalized["tool_calls"] = normalizeStreamToolCalls(
      normalized["tool_calls"],
      choiceIndex,
      state,
    );
  } else if ("tool_calls" in normalized) {
    // Some upstreams emit `tool_calls: null` on non-tool deltas; the OpenAI
    // contract omits the key entirely.
    delete normalized["tool_calls"];
  }
  return normalized;
}

function normalizeStreamToolCalls(
  toolCalls: unknown[],
  choiceIndex = 0,
  state: StreamNormalizeState = createStreamNormalizeState(),
): Array<Record<string, unknown>> {
  return toolCalls
    .filter((toolCall): toolCall is Record<string, unknown> =>
      typeof toolCall === "object" && toolCall !== null && !Array.isArray(toolCall),
    )
    .map((toolCall, fallbackIndex) => {
      const normalized: Record<string, unknown> = { ...toolCall };
      const indexValue = normalized["index"];
      const providerIndex =
        typeof indexValue === "number" && Number.isFinite(indexValue)
          ? indexValue
          : fallbackIndex;

      const incomingId =
        typeof normalized["id"] === "string" && normalized["id"].length > 0
          ? normalized["id"]
          : undefined;
      const fn = normalized["function"];
      const fnObj =
        typeof fn === "object" && fn !== null && !Array.isArray(fn)
          ? (fn as Record<string, unknown>)
          : undefined;
      const incomingName = fnObj?.["name"];
      const hasName = typeof incomingName === "string" && incomingName.length > 0;

      const slotKey = `${choiceIndex}:${providerIndex}`;
      const existingSlot = state.slots.get(slotKey);

      // A fresh id together with a function name marks the START of a new
      // logical tool call, even when the upstream reuses the same delta
      // index (GLM-family providers reset index to 0 for every call, and
      // some omit it entirely). Without this split, downstream clients
      // accumulate two calls' argument fragments into one buffer and the
      // resulting JSON is unparseable. Arguments-only deltas with a flaky
      // id still merge into the current call.
      const isNewCall =
        existingSlot === undefined ||
        (incomingId !== undefined && incomingId !== existingSlot.id && hasName);

      let slot: ToolCallSlot;
      if (isNewCall) {
        const reservedNext = state.nextOutIndex.get(choiceIndex) ?? 0;
        const outIndex =
          existingSlot === undefined ? Math.max(providerIndex, reservedNext) : reservedNext;
        const stableId =
          incomingId ??
          (choiceIndex === 0 ? `call_${outIndex}` : `call_${choiceIndex}_${outIndex}`);
        slot = { outIndex, id: stableId };
        state.slots.set(slotKey, slot);
        state.nextOutIndex.set(choiceIndex, outIndex + 1);
      } else {
        slot = existingSlot;
      }

      const argumentsText =
        typeof fnObj?.["arguments"] === "string"
          ? (fnObj["arguments"] as string)
          : stringifyArguments(fnObj?.["arguments"]);

      // Canonical OpenAI fragment shape. The first fragment of a logical call
      // carries id/type/name; continuations carry ONLY index + arguments.
      // Upstreams like nahcrof re-send the id plus an empty name on every
      // fragment, which strict client accumulators can misread as the start
      // of a new call; stripping the repetition removes that ambiguity.
      if (isNewCall) {
        const name = hasName ? (incomingName as string) : "";
        return {
          index: slot.outIndex,
          id: slot.id,
          type:
            typeof normalized["type"] === "string" && normalized["type"].length > 0
              ? normalized["type"]
              : "function",
          function: { name, arguments: argumentsText },
        };
      }
      return {
        index: slot.outIndex,
        // Preserve non-empty continuation names (rare upstreams stream the
        // name in pieces); empty-string name spam is dropped.
        function: hasName
          ? { name: incomingName as string, arguments: argumentsText }
          : { arguments: argumentsText },
      };
    });
}

function stringifyArguments(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
