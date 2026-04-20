import type { EnforceProtocol, ValidationResult } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ok(reason: string, kind: "tool_calls" | "termination"): ValidationResult {
  return { valid: true, reason, responseType: kind };
}

function fail(reason: string): ValidationResult {
  return { valid: false, reason, responseType: "invalid" };
}

function hasStructuredToolCall(toolCalls: unknown): boolean {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
  for (const call of toolCalls) {
    if (!isObject(call)) continue;
    if (typeof call["id"] !== "string" || call["id"].length === 0) continue;
    const fn = call["function"];
    if (!isObject(fn)) continue;
    if (typeof fn["name"] === "string" && fn["name"].length > 0) return true;
  }
  return false;
}

function openaiTextualContent(
  message: Record<string, unknown>,
): string {
  const raw = message["content"];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (isObject(part) && typeof part["text"] === "string") return part["text"];
        if (typeof part === "string") return part;
        return "";
      })
      .join("");
  }
  return "";
}

export function validateOpenAIResponse(
  response: Record<string, unknown>,
  terminationFlag: string,
): ValidationResult {
  const choices = response["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    return fail("response.choices missing or empty");
  }

  let sawAnyMessage = false;
  for (const choice of choices) {
    if (!isObject(choice)) continue;
    const message = choice["message"];
    if (!isObject(message)) continue;
    sawAnyMessage = true;

    if (hasStructuredToolCall(message["tool_calls"])) {
      return ok("tool_calls present in message", "tool_calls");
    }

    const textual = openaiTextualContent(message);
    if (textual.includes(terminationFlag)) {
      return ok("termination flag present in content", "termination");
    }
  }

  if (!sawAnyMessage) return fail("no message payloads in choices");
  return fail("no tool_calls or termination flag found");
}

export function validateAnthropicResponse(
  response: Record<string, unknown>,
  terminationFlag: string,
): ValidationResult {
  const content = response["content"];
  if (typeof content === "string") {
    if (content.includes(terminationFlag)) {
      return ok("termination flag present in top-level string content", "termination");
    }
    return fail("top-level string content has no termination flag");
  }

  if (!Array.isArray(content) || content.length === 0) {
    return fail("response.content missing or empty");
  }

  for (const block of content) {
    if (!isObject(block)) continue;
    if (block["type"] === "tool_use") {
      if (typeof block["id"] === "string" && typeof block["name"] === "string") {
        return ok("tool_use block present", "tool_calls");
      }
    }
    if (block["type"] === "text") {
      const text = block["text"];
      if (typeof text === "string" && text.includes(terminationFlag)) {
        return ok("termination flag present in text block", "termination");
      }
    }
  }

  return fail("no tool_use or termination flag found");
}

export function validateResponse(
  response: Record<string, unknown>,
  protocol: EnforceProtocol,
  terminationFlag: string,
): ValidationResult {
  if (protocol === "openai") return validateOpenAIResponse(response, terminationFlag);
  return validateAnthropicResponse(response, terminationFlag);
}

/** True if every visible textual content field is empty/whitespace AND no tool calls exist. */
export function isEmptyContentResponse(
  response: Record<string, unknown>,
  protocol: EnforceProtocol,
): boolean {
  if (protocol === "openai") {
    const choices = response["choices"];
    if (!Array.isArray(choices) || choices.length === 0) return true;
    for (const choice of choices) {
      if (!isObject(choice)) continue;
      const message = choice["message"];
      if (!isObject(message)) continue;
      if (hasStructuredToolCall(message["tool_calls"])) return false;
      const text = openaiTextualContent(message).trim();
      if (text.length > 0) return false;
    }
    return true;
  }

  const content = response["content"];
  if (typeof content === "string") return content.trim().length === 0;
  if (!Array.isArray(content)) return true;
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block["type"] === "tool_use") return false;
    if (block["type"] === "text") {
      const text = block["text"];
      if (typeof text === "string" && text.trim().length > 0) return false;
    }
  }
  return true;
}
