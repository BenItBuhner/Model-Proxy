import type { ResolvedRoute } from "@model-proxy/contracts/schemas/index.ts";

import { ProviderAPIError } from "../providers/errors.ts";

/**
 * SSE stream inspection helpers for the routing core: decide whether a
 * stream produced meaningful content (so empty upstream streams can trigger
 * fallback instead of returning a blank response).
 */

export function parseSsePayloads(chunk: string): string[] {
  const out: string[] = [];
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload.length > 0) out.push(payload);
  }
  return out;
}

export function shouldIgnoreReasoningForStreamWinner(
  requestData: Record<string, unknown>,
): boolean {
  const requestTools = requestData["tools"];
  return Array.isArray(requestTools) && requestTools.length > 0;
}

export function isMeaningfulStreamChunk(
  chunk: string,
  targetProtocol: "openai" | "anthropic" | "responses",
  minContentChars: number,
  options: { ignoreReasoning?: boolean } = {},
): boolean {
  for (const payload of parseSsePayloads(chunk)) {
    if (payload === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;
    if (targetProtocol === "anthropic") {
      if (obj["type"] === "content_block_start") return true;
      const delta = obj["delta"];
      if (typeof delta === "object" && delta !== null) {
        const text = (delta as Record<string, unknown>)["text"];
        if (typeof text === "string" && text.trim().length >= minContentChars) return true;
      }
      continue;
    }
    if (targetProtocol === "responses") {
      const eventType = typeof obj["type"] === "string" ? obj["type"] : "";
      // Only content-bearing events count as meaningful. Lifecycle events
      // (created/in_progress/output_item.added/completed) carry no text, so
      // counting them lets an upstream stream that dies before emitting any
      // content pass as "successful" and surface an empty response.
      if (
        eventType === "response.output_text.delta" ||
        eventType === "response.function_call_arguments.delta" ||
        eventType === "response.reasoning_text.delta" ||
        eventType === "response.refusal.delta"
      ) {
        return true;
      }
      continue;
    }
    const choices = obj["choices"];
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      if (typeof choice !== "object" || choice === null) continue;
      const choiceObj = choice as Record<string, unknown>;
      const delta = choiceObj["delta"];
      if (typeof delta === "object" && delta !== null) {
        const deltaObj = delta as Record<string, unknown>;
        const fields = options.ignoreReasoning
          ? ["content"]
          : ["content", "reasoning", "reasoning_content"];
        for (const field of fields) {
          const value = deltaObj[field];
          if (typeof value === "string" && value.trim().length >= minContentChars) {
            return true;
          }
        }
        if (Array.isArray(deltaObj["tool_calls"]) && deltaObj["tool_calls"].length > 0) {
          return true;
        }
      }
      const message = choiceObj["message"];
      if (typeof message === "object" && message !== null) {
        const messageObj = message as Record<string, unknown>;
        const fields = options.ignoreReasoning
          ? ["content"]
          : ["content", "reasoning", "reasoning_content"];
        for (const field of fields) {
          const value = messageObj[field];
          if (typeof value === "string" && value.trim().length >= minContentChars) {
            return true;
          }
        }
        if (Array.isArray(messageObj["tool_calls"]) && messageObj["tool_calls"].length > 0) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Wrap an SSE stream so it only starts flowing once a meaningful chunk has
 * been observed; otherwise throw a 502 that the router treats as
 * fallback-worthy (or pass the empty stream through when allowed).
 */
export async function* requireMeaningfulStream(
  stream: AsyncGenerator<string, void, unknown>,
  route: ResolvedRoute,
  _requestData: Record<string, unknown>,
  targetProtocol: "openai" | "anthropic" | "responses",
  options: { allowEmptyPassthrough?: boolean } = {},
): AsyncGenerator<string, void, unknown> {
  const buffered: string[] = [];
  let emittedMeaningfulChunk = false;

  for await (const chunk of stream) {
    if (emittedMeaningfulChunk) {
      yield chunk;
      continue;
    }

    buffered.push(chunk);
    if (
      isMeaningfulStreamChunk(chunk, targetProtocol, 1, {
        ignoreReasoning: false,
      })
    ) {
      emittedMeaningfulChunk = true;
      for (const bufferedChunk of buffered) yield bufferedChunk;
      buffered.length = 0;
    }
  }

  if (!emittedMeaningfulChunk) {
    // Only pass an empty stream through when the client already saw bytes.
    // Otherwise an upstream stream that ends without meaningful content
    // throws a 502 that the router treats as fallback-worthy (retries the
    // same route with the next key/cycle, then other routes, then surfaces a
    // real error instead of a silent empty 200).
    if (options.allowEmptyPassthrough === true && buffered.length > 0) {
      for (const bufferedChunk of buffered) yield bufferedChunk;
      if (
        targetProtocol === "openai" &&
        !buffered.some((chunk) => parseSsePayloads(chunk).includes("[DONE]"))
      ) {
        yield "data: [DONE]\n\n";
      }
      return;
    }
    throw new ProviderAPIError(
      `${route.provider} stream ended before emitting meaningful content`,
      502,
      {
        provider: route.provider,
        body: buffered.join("").slice(0, 1000),
      },
    );
  }
}
