import type { ProviderConfig } from "../../shared/schemas/provider.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { ProviderAPIError } from "./errors.ts";
import { buildAuthHeaders, buildEndpointUrl } from "./provider-helpers.ts";
import { createLogger } from "../observability/logger.ts";
import {
  parseRetryAfterFromErrorBody,
  parseRetryAfterHeader,
  upstreamFetch,
} from "./upstream-fetch.ts";

const log = createLogger("provider.base");

export interface ProviderCallContext {
  /** Provider-specific API key injected per request by the router. */
  apiKey: string;
  /** Optional base URL override from the route config. */
  baseUrlOverride: string | undefined;
  /** Timeout in seconds for the upstream request. */
  timeoutSeconds: number;
  /** Abort signal forwarded to `fetch`. */
  signal: AbortSignal | undefined;
  /** HTTP(S) egress proxy URL (Bun fetch `proxy` option). */
  egressProxyUrl?: string;
  /** Extra headers forwarded to the upstream provider. */
  extraHeaders?: Record<string, string>;
  /** Buffer streamed tool-call chunks until upstream emits a completed tool call. */
  bufferPartialToolCalls?: boolean;
}

export interface OpenAICallArgs {
  model: string;
  messages: unknown[];
  temperature?: number | undefined;
  top_p?: number | undefined;
  n?: number | undefined;
  stream?: boolean;
  stop?: string | string[] | undefined;
  max_tokens?: number | undefined;
  max_completion_tokens?: number | undefined;
  presence_penalty?: number | undefined;
  frequency_penalty?: number | undefined;
  logit_bias?: Record<string, number> | undefined;
  user?: string | undefined;
  tools?: unknown[] | undefined;
  tool_choice?: unknown;
  response_format?: unknown;
  [key: string]: unknown;
}

export interface AnthropicCallArgs {
  model: string;
  messages: unknown[];
  max_tokens: number;
  system?: unknown;
  temperature?: number | undefined;
  top_p?: number | undefined;
  top_k?: number | undefined;
  stream?: boolean;
  stop_sequences?: string[] | undefined;
  tools?: unknown[] | undefined;
  tool_choice?: unknown;
  [key: string]: unknown;
}

export interface BaseProvider {
  readonly providerName: string;
  readonly config: ProviderConfig;
  readonly wireProtocol: "openai" | "anthropic";

  callOpenAI?(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>>;
  streamOpenAI?(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown>;

  callAnthropic?(
    args: AnthropicCallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>>;
  streamAnthropic?(
    args: AnthropicCallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown>;
}

export abstract class AbstractProvider implements BaseProvider {
  readonly providerName: string;
  readonly config: ProviderConfig;
  readonly wireProtocol: "openai" | "anthropic";

  constructor(providerName: string) {
    this.providerName = providerName;
    this.config = providerConfigLoader.loadProvider(providerName);
    const fmt = this.config.endpoints.compatible_format ?? "openai";
    this.wireProtocol = fmt === "anthropic" ? "anthropic" : "openai";
  }

  protected endpointUrl(
    ctx: ProviderCallContext,
    endpointType: "completions" | "streaming" = "completions",
  ): string {
    return buildEndpointUrl(this.config, ctx.baseUrlOverride, endpointType);
  }

  protected authHeaders(ctx: ProviderCallContext): Record<string, string> {
    return buildAuthHeaders(this.config, ctx.apiKey);
  }

  protected async readErrorBody(response: Response): Promise<string> {
    try {
      return await response.text();
    } catch (err) {
      log.debug("failed to read error body", { err: String(err) });
      return "";
    }
  }

  protected async fetchJson(
    url: string,
    init: RequestInit,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = Math.max(1, ctx.timeoutSeconds * 1000);
    const response = await upstreamFetch(url, {
      ...init,
      proxy: ctx.egressProxyUrl,
      timeoutMs,
      signal: ctx.signal,
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
    return (await response.json()) as Record<string, unknown>;
  }
}
