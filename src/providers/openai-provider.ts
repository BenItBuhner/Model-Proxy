/**
 * OpenAI-compatible provider implementation.
 * Handles OpenAI API calls with key rotation and error handling.
 * Uses native fetch() (Bun-optimized) for upstream requests.
 */
import { getAvailableKeys } from "../core/api-key-manager.ts";
import { getProviderAuthHeaders, getProviderConfig } from "../core/provider-config.ts";
import { BaseProvider, ProviderAPIError } from "./base.ts";
import type { ProviderConfig } from "../types/provider-config.ts";

export class OpenAIProvider extends BaseProvider {
  private config: ProviderConfig;
  private _defaultBaseUrl: string;
  private completionsEndpoint: string;
  private timeout: number;

  constructor(providerName: string = "openai") {
    super(providerName);
    const config = getProviderConfig(providerName);
    if (!config) throw new Error(`${providerName} provider config not found`);
    this.config = config;

    this._defaultBaseUrl = config.endpoints.base_url;
    if (config.proxy_support?.enabled && config.proxy_support.base_url_override) {
      this._defaultBaseUrl = config.proxy_support.base_url_override;
    }
    this.completionsEndpoint = config.endpoints.completions || "/chat/completions";
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

  private buildPayload(model: string, request: Record<string, any>, stream: boolean): Record<string, any> {
    const isGemini = this.providerName === "gemini";
    const isCerebras = this.providerName === "cerebras";

    // Sanitize messages for Gemini
    let messages = request.messages || [];
    if (isGemini) {
      messages = messages.map((msg: any) => {
        if (typeof msg !== "object") return msg;
        const clean: Record<string, any> = { role: msg.role, content: msg.content };
        if (msg.tool_calls) clean.tool_calls = msg.tool_calls;
        if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;
        if (msg.name) clean.name = msg.name;
        return clean;
      });
    }

    const payload: Record<string, any> = { model, messages, stream };

    if (request.temperature != null && (!isGemini || request.temperature !== 1.0))
      payload.temperature = request.temperature;
    if (request.top_p != null && (!isGemini || request.top_p !== 1.0))
      payload.top_p = request.top_p;
    if (request.n != null && !isGemini && !isCerebras)
      payload.n = request.n;
    if (request.stop != null && !isGemini)
      payload.stop = request.stop;
    if (request.max_tokens != null) {
      if (isCerebras) payload.max_completion_tokens = request.max_tokens;
      else payload.max_tokens = request.max_tokens;
    }
    if (request.presence_penalty != null && !isGemini && !isCerebras)
      payload.presence_penalty = request.presence_penalty;
    if (request.logit_bias != null && !isGemini && !isCerebras)
      payload.logit_bias = request.logit_bias;
    if (request.user != null && !isGemini)
      payload.user = request.user;
    if (request.tools) payload.tools = request.tools;
    if (request.tool_choice) payload.tool_choice = request.tool_choice;

    return payload;
  }

  async call(model: string, request: Record<string, any>): Promise<Record<string, any>> {
    const keys = this.getAvailableApiKeys();
    if (keys.length === 0) throw new Error(`No ${this.providerName} API keys available`);

    let lastError: Error | null = null;

    for (const apiKey of keys) {
      try {
        const url = this.getEndpointUrl();
        const authHeaders = getProviderAuthHeaders(this.providerName, apiKey);
        const payload = this.buildPayload(model, request, false);

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
            lastError = new ProviderAPIError(
              `${this.providerName} API error ${response.status}: ${body.slice(0, 500)}`,
              response.status,
              body
            );
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
          `${this.providerName} error: ${e.message}`, 500, null
        );
        continue;
      }
    }

    throw lastError || new Error(`All ${this.providerName} API keys failed`);
  }

  async *callStream(model: string, request: Record<string, any>): AsyncGenerator<string, void, unknown> {
    const keys = this.getAvailableApiKeys();
    if (keys.length === 0) throw new Error(`No ${this.providerName} API keys available`);

    let lastError: Error | null = null;

    for (const apiKey of keys) {
      try {
        const url = this.getEndpointUrl();
        const authHeaders = getProviderAuthHeaders(this.providerName, apiKey);
        const payload = this.buildPayload(model, request, true);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              ...authHeaders,
              "Content-Type": "application/json",
              "Accept": "text/event-stream",
            },
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
            `${this.providerName} API error ${response.status}: ${body.slice(0, 500)}`,
            response.status,
            body
          );
          continue;
        }

        // Check if not SSE - convert to single chunk
        const contentType = (response.headers.get("content-type") || "").toLowerCase();
        if (!contentType.includes("text/event-stream")) {
          clearTimeout(timeoutId);
          const data = await response.json();
          const content = data?.choices?.[0]?.message?.content || "";
          const toolCalls = data?.choices?.[0]?.message?.tool_calls;
          const delta: Record<string, any> = { role: "assistant", content };
          if (toolCalls) delta.tool_calls = toolCalls;
          const chunk = {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta }],
          };
          yield `data: ${JSON.stringify(chunk)}\n\n`;
          yield "data: [DONE]\n\n";
          return;
        }

        // Stream SSE
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
              if (!trimmed || trimmed === "data:") continue;

              if (trimmed === "data: [DONE]") {
                yield "data: [DONE]\n\n";
                continue;
              }

              if (trimmed.startsWith("data:")) {
                const jsonStr = trimmed.slice(5).trim();
                if (!jsonStr || jsonStr === "[DONE]") {
                  if (jsonStr === "[DONE]") yield "data: [DONE]\n\n";
                  continue;
                }

                try {
                  const parsed = JSON.parse(jsonStr);
                  if (parsed.error) {
                    const errMsg = parsed.error.message || JSON.stringify(parsed);
                    throw new ProviderAPIError(
                      `Stream error from ${this.providerName}: ${errMsg}`,
                      parsed.error.code || 500,
                      jsonStr
                    );
                  }
                  yield `data: ${JSON.stringify(parsed)}\n\n`;
                } catch (e) {
                  if (e instanceof ProviderAPIError) throw e;
                  // Skip malformed JSON
                  continue;
                }
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
          `${this.providerName} error: ${e.message}`, 500, null
        );
        continue;
      }
    }

    throw lastError || new Error(`All ${this.providerName} API keys failed`);
  }
}
