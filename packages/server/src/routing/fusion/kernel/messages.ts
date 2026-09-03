import { stableHash } from "../../../shared/utils.ts";

/**
 * Protocol-agnostic message helpers. Fusion sees OpenAI-shaped messages
 * (`role: "tool"`, `tool_calls`) and Anthropic-shaped messages (content
 * blocks with `tool_use` / `tool_result`) depending on the client route.
 */

export interface MessageView {
  index: number;
  role: string;
  text: string;
  isToolResult: boolean;
  hasToolCalls: boolean;
  hasImages: boolean;
  toolNames: string[];
}

export function asRecord(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== "object" || message === null || Array.isArray(message)) return undefined;
  return message as Record<string, unknown>;
}

export function messageRole(message: unknown): string {
  const obj = asRecord(message);
  return typeof obj?.["role"] === "string" ? (obj["role"] as string) : "";
}

/** Plain text of a message, including tool_result payloads and text parts. */
export function messageText(message: unknown): string {
  const obj = asRecord(message);
  if (obj === undefined) return "";
  const content = obj["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined || content === null ? "" : JSON.stringify(content);
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const p = asRecord(part);
    if (p === undefined) continue;
    if (typeof p["text"] === "string") parts.push(p["text"]);
    if (p["type"] === "tool_result") {
      const inner = p["content"];
      if (typeof inner === "string") parts.push(inner);
      else if (Array.isArray(inner)) {
        for (const ip of inner) {
          const ipo = asRecord(ip);
          if (typeof ipo?.["text"] === "string") parts.push(ipo["text"] as string);
        }
      }
    }
  }
  return parts.join("\n");
}

export function isToolResultMessage(message: unknown): boolean {
  const obj = asRecord(message);
  if (obj === undefined) return false;
  if (obj["role"] === "tool") return true;
  const content = obj["content"];
  if (!Array.isArray(content)) return false;
  return content.some((part) => asRecord(part)?.["type"] === "tool_result");
}

export function hasToolCalls(message: unknown): boolean {
  const obj = asRecord(message);
  if (obj === undefined) return false;
  if (Array.isArray(obj["tool_calls"]) && (obj["tool_calls"] as unknown[]).length > 0) return true;
  if (obj["function_call"] !== undefined) return true;
  const content = obj["content"];
  if (!Array.isArray(content)) return false;
  return content.some((part) => asRecord(part)?.["type"] === "tool_use");
}

export function hasImages(message: unknown): boolean {
  const obj = asRecord(message);
  const content = obj?.["content"];
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const type = asRecord(part)?.["type"];
    return type === "image_url" || type === "image";
  });
}

export function toolCallNames(message: unknown): string[] {
  const obj = asRecord(message);
  if (obj === undefined) return [];
  const names: string[] = [];
  const toolCalls = obj["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const fn = asRecord(asRecord(tc)?.["function"]);
      if (typeof fn?.["name"] === "string") names.push(fn["name"] as string);
    }
  }
  const content = obj["content"];
  if (Array.isArray(content)) {
    for (const part of content) {
      const p = asRecord(part);
      if (p?.["type"] === "tool_use" && typeof p["name"] === "string") names.push(p["name"] as string);
    }
  }
  return names;
}

export function viewMessage(message: unknown, index: number): MessageView {
  return {
    index,
    role: messageRole(message),
    text: messageText(message),
    isToolResult: isToolResultMessage(message),
    hasToolCalls: hasToolCalls(message),
    hasImages: hasImages(message),
    toolNames: toolCallNames(message),
  };
}

const ACK_WORDS = new Set([
  "ok", "okay", "yes", "yep", "yeah", "no", "nope", "sure", "thanks", "thank", "you",
  "got", "it", "sounds", "good", "continue", "proceed", "keep", "going", "go", "on",
  "ahead", "do", "next", "done", "nice", "great", "cool", "lgtm", "perfect", "please",
  "fine", "alright", "right", "correct", "exactly", "yup", "k", "kk", "ty", "thx",
]);

/** True when a short user message is only an acknowledgment / continue nudge. */
export function isAcknowledgment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > 80) return false;
  const words = trimmed.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  return words.every((word) => ACK_WORDS.has(word));
}

/** Normalize instruction text for hashing/equality (whitespace + case insensitive). */
export function normalizeInstruction(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

export function instructionHash(text: string): string {
  return stableHash(normalizeInstruction(text)).slice(0, 32);
}

/**
 * Per-message content hash used for prefix matching between turns. Large
 * payloads are hashed whole; tool_call ids are included so a re-issued call
 * with a different id is a different message.
 */
export function hashMessage(message: unknown): string {
  const obj = asRecord(message);
  if (obj === undefined) return stableHash(message).slice(0, 24);
  return stableHash({
    role: obj["role"],
    content: obj["content"],
    tool_calls: obj["tool_calls"],
    tool_call_id: obj["tool_call_id"],
    name: obj["name"],
  }).slice(0, 24);
}

export function hashMessages(messages: unknown[]): string[] {
  return messages.map((message) => hashMessage(message));
}

/** Longest common prefix length between two hash lists. */
export function commonPrefixLength(a: string[], b: string[]): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

/** Index of the last substantive user instruction (not an ack, not a tool result). */
export function findLastUserInstruction(messages: unknown[]): { index: number; text: string } {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (messageRole(message) !== "user") continue;
    if (isToolResultMessage(message)) continue;
    const text = messageText(message).trim();
    if (text.length === 0 && !hasImages(message)) continue;
    if (isAcknowledgment(text) && !hasImages(message)) continue;
    return { index: i, text };
  }
  return { index: -1, text: "" };
}

export function firstSystemPrompt(messages: unknown[]): string | undefined {
  for (const message of messages) {
    if (messageRole(message) === "system") {
      const text = messageText(message);
      return text.length > 0 ? text : undefined;
    }
  }
  return undefined;
}

const ERROR_LINE = /(^|\n)[^\n]*\b(error|exception|traceback|failed|failure|panic|segfault|cannot|could not|not found|permission denied|no such file|command not found|exit code [1-9]\d*|status[: ]+[45]\d\d|enoent|eacces|econnrefused|typeerror|referenceerror|syntaxerror|assertionerror)\b[^\n]*/i;
const TRIVIAL_ERROR_CONTEXT = /\b(no error|0 errors|without error|error handling|error boundary|on error|error:\s*null|errors?:\s*\[\s*\]|errors?:\s*0\b)/i;

/**
 * Detect an error signal in a tool result and return a stable signature +
 * short excerpt. Returns undefined when the text looks healthy.
 */
export function detectToolError(text: string): { signature: string; excerpt: string } | undefined {
  if (text.length === 0) return undefined;
  const match = text.match(ERROR_LINE);
  if (match === null) return undefined;
  const line = match[0].trim();
  if (TRIVIAL_ERROR_CONTEXT.test(line)) return undefined;
  const excerpt = line.length > 240 ? `${line.slice(0, 237)}...` : line;
  // Signature ignores digits/paths so repeated variants of the same failure collapse.
  const normalized = excerpt
    .toLowerCase()
    .replace(/[0-9]+/g, "#")
    .replace(/[\w./\\-]+[\\/][\w./\\-]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
  return { signature: stableHash(normalized).slice(0, 24), excerpt };
}

/** Head/tail truncation that keeps the beginning and end of long payloads. */
export function truncateMiddle(text: string, maxChars: number, note = "omitted middle"): string {
  if (text.length <= maxChars) return text;
  const marker = `\n[... ${note}: ${text.length - maxChars} chars ...]\n`;
  const available = Math.max(0, maxChars - marker.length);
  if (available <= 0) return marker.trim();
  const headChars = Math.max(1, Math.floor(available * 0.6));
  const tailChars = Math.max(1, available - headChars);
  return `${text.slice(0, headChars).trimEnd()}${marker}${text.slice(text.length - tailChars).trimStart()}`;
}
