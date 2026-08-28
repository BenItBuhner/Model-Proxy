import type { ProviderConfig } from "@model-proxy/contracts/schemas/provider.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { ProviderAPIError } from "./errors.ts";
import { buildAuthHeaders, buildEndpointUrl } from "./provider-helpers.ts";
import { createLogger } from "../observability/logger.ts";
import {
  parseRetryAfterFromErrorBody,
  parseRetryAfterHeader,
  readBodyWithDeadline,
  upstreamFetch,
} from "./upstream-fetch.ts";

const log = createLogger("provider.base");

export interface ProviderCallContext {
  /** Provider-specific API key injected per request by the router. */
  apiKey: string;
  /** Opaque account reference when apiKey was resolved from the account store. */
  accountRef?: string;
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
  seed?: number | undefined;
  prompt_cache_key?: string | undefined;
  tools?: unknown[] | undefined;
  tool_choice?: unknown;
  parallel_tool_calls?: boolean | undefined;
  response_format?: unknown;
  reasoning?: unknown;
  reasoning_effort?: unknown;
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
  thinking?: unknown;
  [key: string]: unknown;
}

/** Native OpenAI Responses API request arguments. */
export interface ResponsesCallArgs {
  model: string;
  input?: unknown;
  instructions?: string;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stream?: boolean;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  tools?: unknown[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  metadata?: Record<string, unknown>;
  store?: boolean;
  previous_response_id?: string;
  reasoning?: unknown;
  truncation?: unknown;
  text?: unknown;
  include?: string[];
  [key: string]: unknown;
}

export interface BaseProvider {
  readonly providerName: string;
  readonly config: ProviderConfig;
  readonly wireProtocol: "openai" | "anthropic" | "responses";

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

  callResponses?(
    args: ResponsesCallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>>;
  streamResponses?(
    args: ResponsesCallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown>;
}

export abstract class AbstractProvider implements BaseProvider {
  readonly providerName: string;
  readonly config: ProviderConfig;
  readonly wireProtocol: "openai" | "anthropic" | "responses";

  constructor(providerName: string) {
    this.providerName = providerName;
    this.config = providerConfigLoader.loadProvider(providerName);
    const fmt = this.config.endpoints.compatible_format ?? "openai";
    this.wireProtocol = fmt === "anthropic" ? "anthropic" : fmt === "responses" ? "responses" : "openai";
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
      return await readBodyWithDeadline(response, () => response.text(), 15_000);
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
    // The header-phase timeout above no longer applies; give the body read its
    // own deadline so a mid-body upstream stall can't hang non-streaming calls.
    return await readBodyWithDeadline(
      response,
      () => response.json() as Promise<Record<string, unknown>>,
      timeoutMs,
    );
  }
}
