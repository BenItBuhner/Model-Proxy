import { createLogger } from "../observability/logger.ts";
import {
  AbstractProvider,
  type AnthropicCallArgs,
  type OpenAICallArgs,
  type ProviderCallContext,
} from "./base.ts";
import { ProviderAPIError } from "./errors.ts";
import { upstreamFetch } from "./upstream-fetch.ts";
import { readSSELines, sseInactivityTimeoutMs } from "./openai-provider.ts";

const log = createLogger("provider.anthropic");

export class AnthropicProvider extends AbstractProvider {
  constructor(providerName = "anthropic") {
    super(providerName);
  }

  async callAnthropic(
    args: AnthropicCallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    const payload = this.buildPayload({ ...args, stream: false });
    const url = this.endpointUrl(ctx);
    log.debug("upstream request", {
      model: args.model,
      messageCount: Array.isArray(args.messages) ? args.messages.length : 0,
    });
    return await this.fetchJson(
      url,
      {
        method: "POST",
        headers: {
          ...this.authHeaders(ctx),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      },
      ctx,
    );
  }

  async *streamAnthropic(
    args: AnthropicCallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown> {
    const payload = this.buildPayload({ ...args, stream: true });
    const url = this.endpointUrl(ctx, "streaming");
    const timeoutMs = Math.max(1, ctx.timeoutSeconds * 1000);

    // Own the connection: aborting is the only reliable way to release a
    // partially-consumed streaming body out of Bun's per-host pool (see
    // streamOpenAI for the full story).
    const connController = new AbortController();
    const onCallerAbort = () => connController.abort();
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) connController.abort();
      else ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      const response = await upstreamFetch(url, {
        method: "POST",
        headers: {
          ...this.authHeaders(ctx),
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
        proxy: ctx.egressProxyUrl,
        timeoutMs,
        signal: connController.signal,
      });

      if (response.status >= 400) {
        const body = await this.readErrorBody(response);
        throw new ProviderAPIError(
          `anthropic API error ${response.status}: ${body.slice(0, 500)}`,
          response.status,
          { body, provider: "anthropic" },
        );
      }

      if (response.body === null) {
        throw new ProviderAPIError(
          "anthropic streaming response body was empty",
          502,
          { provider: "anthropic" },
        );
      }

      for await (const line of readSSELines(response.body, sseInactivityTimeoutMs(ctx.timeoutSeconds))) {
        if (line.length === 0) continue;
        yield `${line}\n\n`;
      }
    } finally {
      ctx.signal?.removeEventListener("abort", onCallerAbort);
      connController.abort();
    }
  }

  async callOpenAI(
    _args: OpenAICallArgs,
    _ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    throw new Error(
      "Anthropic provider does not implement the OpenAI wire protocol directly",
    );
  }

  private buildPayload(args: AnthropicCallArgs): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: args.model,
      messages: args.messages,
      max_tokens: args.max_tokens,
      stream: args.stream ?? false,
    };
    if (args.system !== undefined) payload["system"] = args.system;
    if (args.temperature !== undefined) payload["temperature"] = args.temperature;
    if (args.top_p !== undefined) payload["top_p"] = args.top_p;
    if (args.top_k !== undefined) payload["top_k"] = args.top_k;
    if (args.stop_sequences !== undefined) payload["stop_sequences"] = args.stop_sequences;
    if (args.tools !== undefined) payload["tools"] = args.tools;
    if (args.tool_choice !== undefined) payload["tool_choice"] = args.tool_choice;
    if (args.thinking !== undefined) payload["thinking"] = args.thinking;
    return payload;
  }
}
