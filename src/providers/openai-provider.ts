import { createLogger } from "../observability/logger.ts";
import {
  AbstractProvider,
  type AnthropicCallArgs,
  type OpenAICallArgs,
  type ProviderCallContext,
} from "./base.ts";
import { ProviderAPIError } from "./errors.ts";
import {
  parseRetryAfterFromErrorBody,
  parseRetryAfterHeader,
  upstreamFetch,
} from "./upstream-fetch.ts";

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

  async *streamOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown> {
    const payload = this.buildPayload({ ...args, stream: true });
    const url = this.endpointUrl(ctx, "streaming");

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(1, ctx.timeoutSeconds * 1000),
    );
    const externalSignal = ctx.signal;
    const onExternalAbort = () => controller.abort();
    if (externalSignal !== undefined) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const response = await upstreamFetch(url, {
        method: "POST",
        headers: this.openAIRequestHeaders(ctx, "text/event-stream"),
        body: JSON.stringify(payload),
        proxy: ctx.egressProxyUrl,
        timeoutMs: Math.max(1, ctx.timeoutSeconds * 1000),
        signal: controller.signal,
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
          data = (await response.json()) as Record<string, unknown>;
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

      for await (const line of readSSELines(response.body)) {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed === "data:") continue;
        if (trimmed === "data: [DONE]") {
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
          yield `data: ${JSON.stringify(parsed)}\n\n`;
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
    } finally {
      clearTimeout(timer);
      if (externalSignal !== undefined) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
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
    if (
      args.chat_template_kwargs !== undefined &&
      !isChatTemplateKwargsPassthroughDisabled()
    ) {
      payload["chat_template_kwargs"] = args.chat_template_kwargs;
    }

    return payload;
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
  const choices = data["choices"];
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const msg = (first["message"] as Record<string, unknown>) ?? {};
    const rawContent = msg["content"];
    if (typeof rawContent === "string") content = rawContent;
    if (msg["tool_calls"] !== undefined) toolCalls = msg["tool_calls"];
  }
  const delta: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls !== undefined) delta["tool_calls"] = toolCalls;
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

async function* readSSELines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
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
    reader.releaseLock();
  }
}

export { readSSELines };
