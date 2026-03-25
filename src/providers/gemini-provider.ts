/**
 * Gemini OpenAI-compatible provider implementation.
 * Uses Google's OpenAI-compatible endpoint for Gemini models.
 * Strips unsupported parameters and handles Gemini-specific quirks.
 */
import { getAvailableKeys } from "../core/api-key-manager.ts";
import { env } from "../core/env.ts";
import { BaseProvider, ProviderAPIError } from "./base.ts";

const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

// Cache thought_signatures for tool-call continuations
const _thoughtSignatureCache: Map<string, string> = new Map();

export class GeminiProvider extends BaseProvider {
  private _baseUrl: string;
  private timeout: number = 120;

  constructor() {
    super("gemini");
    this._baseUrl = GEMINI_OPENAI_BASE_URL;
  }

  get baseUrl(): string {
    return this._routeBaseUrl || this._baseUrl;
  }

  private getEndpointUrl(): string {
    const base = this.baseUrl;
    return base.endsWith("/") ? `${base}chat/completions` : `${base}/chat/completions`;
  }

  private getAvailableApiKeys(): string[] {
    if (this._routeApiKey) return [this._routeApiKey];
    return getAvailableKeys(this.providerName);
  }

  private sanitizeMessages(messages: Record<string, any>[]): Record<string, any>[] {
    // Inject cached thought signatures
    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          const tcId = tc.id;
          if (tcId && _thoughtSignatureCache.has(tcId)) {
            if (!tc.extra_content) tc.extra_content = {};
            if (!tc.extra_content.google) tc.extra_content.google = {};
            tc.extra_content.google.thought_signature = _thoughtSignatureCache.get(tcId);
          }
        }
      }
    }

    return messages.map((msg) => {
      if (typeof msg !== "object") return msg;
      const clean: Record<string, any> = {};
      if (msg.role) clean.role = msg.role;
      if (msg.content !== undefined) clean.content = msg.content;
      if (msg.role === "assistant" && msg.tool_calls) clean.tool_calls = msg.tool_calls;
      if (msg.role === "tool") {
        if (msg.tool_call_id) clean.tool_call_id = msg.tool_call_id;
        if (msg.name) clean.name = msg.name;
      }
      return clean;
    });
  }

  private stripGeminiExtensions(data: Record<string, any>, hasSeenToolCalls: boolean = false): { data: Record<string, any>; hadToolCalls: boolean } {
    let hadToolCalls = false;
    if (!data.choices) return { data, hadToolCalls };

    for (const choice of data.choices) {
      // Handle streaming delta
      const delta = choice.delta;
      if (delta?.tool_calls) {
        if (!env.GEMINI_INCLUDE_THOUGHT_SIGNATURE) {
          const cleaned: any[] = [];
          for (const tc of delta.tool_calls) {
            const tcId = tc.id;
            const extraContent = tc.extra_content;
            const thoughtSig = extraContent?.google?.thought_signature;
            if (tcId && thoughtSig) _thoughtSignatureCache.set(tcId, thoughtSig);
            delete tc.extra_content;
            if (tc.id || tc.type || tc.function) {
              if (tc.function && !tc.type) tc.type = "function";
              cleaned.push(tc);
            }
          }
          for (let i = 0; i < cleaned.length; i++) {
            if (cleaned[i].index === undefined) cleaned[i].index = i;
          }
          if (cleaned.length > 0) { delta.tool_calls = cleaned; hadToolCalls = true; }
          else delete delta.tool_calls;
        } else hadToolCalls = true;
      }

      if (hasSeenToolCalls && choice.finish_reason === "stop") choice.finish_reason = "tool_calls";

      // Handle non-streaming message
      const message = choice.message;
      if (message?.tool_calls) {
        if (!env.GEMINI_INCLUDE_THOUGHT_SIGNATURE) {
          const cleaned: any[] = [];
          for (const tc of message.tool_calls) {
            const tcId = tc.id;
            const extraContent = tc.extra_content;
            const thoughtSig = extraContent?.google?.thought_signature;
            if (tcId && thoughtSig) _thoughtSignatureCache.set(tcId, thoughtSig);
            delete tc.extra_content;
            if (tc.id || tc.type || tc.function) {
              if (tc.function && !tc.type) tc.type = "function";
              cleaned.push(tc);
            }
          }
          for (let i = 0; i < cleaned.length; i++) {
            if (cleaned[i].index === undefined) cleaned[i].index = i;
          }
          if (cleaned.length > 0) { message.tool_calls = cleaned; hadToolCalls = true; }
          else delete message.tool_calls;
        } else hadToolCalls = true;
      }
    }

    return { data, hadToolCalls };
  }

  private buildPayload(model: string, messages: Record<string, any>[], stream: boolean, request: Record<string, any>): Record<string, any> {
    const payload: Record<string, any> = {
      model,
      messages: this.sanitizeMessages(messages),
      stream,
    };
    if (request.temperature != null && request.temperature !== 1.0) payload.temperature = request.temperature;
    if (request.max_tokens != null) payload.max_tokens = request.max_tokens;
    if (request.top_p != null && request.top_p !== 1.0) payload.top_p = request.top_p;
    if (request.tools) payload.tools = request.tools;
    if (request.tool_choice) payload.tool_choice = request.tool_choice;
    return payload;
  }

  async call(model: string, request: Record<string, any>): Promise<Record<string, any>> {
    const keys = this.getAvailableApiKeys();
    if (keys.length === 0) throw new Error("No Gemini API keys available");

    let lastError: Error | null = null;

    for (const apiKey of keys) {
      try {
        const url = this.getEndpointUrl();
        const payload = this.buildPayload(model, request.messages || [], false, request);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);

        try {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            if (!this._routeApiKey) this.markKeyFailed(apiKey);
            const body = await response.text();
            lastError = new ProviderAPIError(
              `Gemini API error: HTTP ${response.status}`,
              response.status,
              body
            );
            continue;
          }

          const result = await response.json();
          const { data: cleaned } = this.stripGeminiExtensions(result);
          return cleaned;
        } catch (e: any) {
          clearTimeout(timeoutId);
          throw e;
        }
      } catch (e: any) {
        if (e instanceof ProviderAPIError) { lastError = e; continue; }
        if (!this._routeApiKey) this.markKeyFailed(apiKey);
        lastError = new ProviderAPIError(`Gemini API error: ${e.message}`, 500, String(e));
        continue;
      }
    }

    throw lastError || new Error("All Gemini API keys failed");
  }

  async *callStream(model: string, request: Record<string, any>): AsyncGenerator<string, void, unknown> {
    const keys = this.getAvailableApiKeys();
    if (keys.length === 0) throw new Error("No Gemini API keys available");

    let lastError: Error | null = null;

    for (const apiKey of keys) {
      try {
        const url = this.getEndpointUrl();
        const payload = this.buildPayload(model, request.messages || [], true, request);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeout * 1000);

        let response: Response;
        try {
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${apiKey}`,
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
            `Gemini API error: HTTP ${response.status}`,
            response.status,
            body
          );
          continue;
        }

        const reader = response.body?.getReader();
        if (!reader) { clearTimeout(timeoutId); throw new Error("No response body"); }

        const decoder = new TextDecoder();
        let buffer = "";
        let hasSeenToolCalls = false;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              if (trimmed === "data: [DONE]") { yield "data: [DONE]\n\n"; continue; }
              if (trimmed === "data:") continue;

              if (trimmed.startsWith("data:")) {
                const jsonStr = trimmed.slice(5).trim();
                if (!jsonStr || jsonStr === "[DONE]") {
                  if (jsonStr === "[DONE]") yield "data: [DONE]\n\n";
                  continue;
                }
                try {
                  const parsed = JSON.parse(jsonStr);
                  if (parsed.error) {
                    const msg = parsed.error.message || JSON.stringify(parsed);
                    throw new ProviderAPIError(`Gemini stream error: ${msg}`, 500, jsonStr);
                  }
                  const { data: cleaned, hadToolCalls } = this.stripGeminiExtensions(parsed, hasSeenToolCalls);
                  if (hadToolCalls) hasSeenToolCalls = true;
                  yield `data: ${JSON.stringify(cleaned)}\n\n`;
                } catch (e) {
                  if (e instanceof ProviderAPIError) throw e;
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
        if (e instanceof ProviderAPIError) { lastError = e; continue; }
        if (!this._routeApiKey) this.markKeyFailed(apiKey);
        lastError = new ProviderAPIError(`Gemini API error: ${e.message}`, 500, String(e));
        continue;
      }
    }

    throw lastError || new Error("All Gemini API keys failed");
  }
}
