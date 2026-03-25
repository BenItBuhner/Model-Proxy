/**
 * Anthropic provider implementation.
 * Handles Anthropic API calls with key rotation and error handling.
 * Uses native fetch() for upstream requests.
 */
import { getAvailableKeys } from "../core/api-key-manager.ts";
import { getProviderAuthHeaders, getProviderConfig } from "../core/provider-config.ts";
import { BaseProvider, ProviderAPIError } from "./base.ts";
import type { ProviderConfig } from "../types/provider-config.ts";

export class AnthropicProvider extends BaseProvider {
  private config: ProviderConfig;
  private _defaultBaseUrl: string;
  private completionsEndpoint: string;
  private timeout: number;

  constructor() {
    super("anthropic");
    const config = getProviderConfig("anthropic");
    if (!config) throw new Error("Anthropic provider config not found");
    this.config = config;

    this._defaultBaseUrl = config.endpoints.base_url;
    if (config.proxy_support?.enabled && config.proxy_support.base_url_override) {
      this._defaultBaseUrl = config.proxy_support.base_url_override;
    }
    this.completionsEndpoint = config.endpoints.completions || "/messages";
    this.timeout = config.request_config?.timeout_seconds ?? 60;
  }

  get baseUrl(): string {
    return this.getEffectiveBaseUrl(this._defaultBaseUrl);
  }

  private getEndpointUrl(): string {
    let ep = this.completionsEndpoint;
    if (ep.startsWith("/")) ep = ep.slice(1);
    const base = this.baseUrl;
    return base.endsWith("/") ? `${base}${ep}` : `${base}/${ep}`;
  }

  private getAvailableApiKeys(): string[] {
    if (this._routeApiKey) return [this._routeApiKey];
    return getAvailableKeys(this.providerName);
  }

  async call(model: string, request: Record<string, any>): Promise<Record<string, any>> {
    const keys = this.getAvailableApiKeys();
    if (keys.length === 0) throw new Error("No anthropic API keys available");

    let lastError: Error | null = null;

    for (const apiKey of keys) {
      try {
        const url = this.getEndpointUrl();
        const authHeaders = getProviderAuthHeaders("anthropic", apiKey);

        const payload: Record<string, any> = {
          model,
          messages: request.messages || [],
          max_tokens: request.max_tokens || 4096,
          stream: false,
        };

        if (request.temperature != null) payload.temperature = request.temperature;
        if (request.top_p != null) payload.top_p = request.top_p;
        if (request.top_k != null) payload.top_k = request.top_k;
        if (request.tools) payload.tools = request.tools;
        if (request.system != null) payload.system = request.system;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);

        try {
          const response = await fetch(url, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const body = await response.text();
            if (!this._routeApiKey) this.markKeyFailed(apiKey);
            const err = new ProviderAPIError(
              `Anthropic API error ${response.status}: ${body.slice(0, 500)}`,
              response.status,
              body
            );
            lastError = err;
            continue;
          }

          return await response.json();
        } catch (e: any) {
          clearTimeout(timeoutId);
          throw e;
        }
      } catch (e: any) {
        if (!this._routeApiKey) this.markKeyFailed(apiKey);
        lastError = e instanceof ProviderAPIError ? e : new ProviderAPIError(
          `Anthropic error: ${e.message}`, 500, null
        );
        continue;
      }
    }

    throw lastError || new Error("All Anthropic API keys failed");
  }

  async *callStream(model: string, request: Record<string, any>): AsyncGenerator<string, void, unknown> {
    const keys = this.getAvailableApiKeys();
    if (keys.length === 0) throw new Error("No anthropic API keys available");

    let lastError: Error | null = null;

    for (const apiKey of keys) {
      try {
        const url = this.getEndpointUrl();
        const authHeaders = getProviderAuthHeaders("anthropic", apiKey);

        const payload: Record<string, any> = {
          model,
          messages: request.messages || [],
          max_tokens: request.max_tokens || 4096,
          stream: true,
        };

        if (request.temperature != null) payload.temperature = request.temperature;
        if (request.top_p != null) payload.top_p = request.top_p;
        if (request.top_k != null) payload.top_k = request.top_k;
        if (request.tools) payload.tools = request.tools;
        if (request.system != null) payload.system = request.system;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: { ...authHeaders, "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
        } catch (e: any) {
          clearTimeout(timeoutId);
          throw e;
        }

        if (!response.ok) {
          clearTimeout(timeoutId);
          const body = await response.text();
          if (!this._routeApiKey) this.markKeyFailed(apiKey);
          lastError = new ProviderAPIError(
            `Anthropic API error ${response.status}: ${body.slice(0, 500)}`,
            response.status,
            body
          );
          continue;
        }

        const reader = response.body?.getReader();
        if (!reader) { clearTimeout(timeoutId); throw new Error("No response body"); }

        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                yield `${trimmed}\n\n`;
              }
            }
          }
        } finally {
          clearTimeout(timeoutId);
          reader.releaseLock();
        }

        return; // Success
      } catch (e: any) {
        if (!this._routeApiKey) this.markKeyFailed(apiKey);
        lastError = e instanceof ProviderAPIError ? e : new ProviderAPIError(
          `Anthropic error: ${e.message}`, 500, null
        );
        continue;
      }
    }

    throw lastError || new Error("All Anthropic API keys failed");
  }
}
