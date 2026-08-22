import type { EnforceProtocol } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Removes the termination flag from textual content in the response. Never
 * touches tool_calls / tool_use objects. Also handles the edge case where
 * stripping the flag leaves empty content with no tool calls — in that case
 * OpenAI content is set to `null` (valid for tool-only messages) and the
 * finish_reason is set to "stop".
 */
export function stripTerminationFlag(
  response: Record<string, unknown>,
  terminationFlag: string,
  protocol: EnforceProtocol,
): Record<string, unknown> {
  if (protocol === "openai") return stripOpenAI(response, terminationFlag);
  return stripAnthropic(response, terminationFlag);
}

function stripText(text: string, flag: string): string {
  if (flag.length === 0) return text;
  const stripped = text.split(flag).join("");
  return stripped.trim();
}

function stripOpenAI(
  response: Record<string, unknown>,
  flag: string,
): Record<string, unknown> {
  const choices = response["choices"];
  if (!Array.isArray(choices)) return response;

  const newChoices = choices.map((choice) => {
    if (!isObject(choice)) return choice;
    const message = choice["message"];
    if (!isObject(message)) return choice;

    let cleanedContent: unknown = message["content"];
    if (typeof message["content"] === "string") {
      cleanedContent = stripText(message["content"], flag);
    } else if (Array.isArray(message["content"])) {
      cleanedContent = message["content"].map((part) => {
        if (isObject(part) && typeof part["text"] === "string") {
          return { ...part, text: stripText(part["text"], flag) };
        }
        return part;
      });
    }

    const toolCalls = message["tool_calls"];
    const hasTools = Array.isArray(toolCalls) && toolCalls.length > 0;

    const sanitizedContent = sanitizeEmptyOpenAIContent(cleanedContent, hasTools);

    const newMessage: Record<string, unknown> = { ...message, content: sanitizedContent };

    let newFinishReason = choice["finish_reason"];
    if (sanitizedContent === null && !hasTools) {
      newFinishReason = "stop";
    }

    return { ...choice, message: newMessage, finish_reason: newFinishReason };
  });

  return { ...response, choices: newChoices };
}

function sanitizeEmptyOpenAIContent(content: unknown, hasTools: boolean): unknown {
  if (typeof content === "string") {
    if (content.length === 0 || content.trim().length === 0) {
      return hasTools ? null : null;
    }
    return content;
  }
  if (Array.isArray(content)) {
    const filtered = content.filter((part) => {
      if (isObject(part) && typeof part["text"] === "string") {
        return part["text"].trim().length > 0;
      }
      return part !== undefined && part !== null;
    });
    if (filtered.length === 0) return hasTools ? null : null;
    return filtered;
  }
  return content;
}

function stripAnthropic(
  response: Record<string, unknown>,
  flag: string,
): Record<string, unknown> {
  if (typeof response["content"] === "string") {
    return {
      ...response,
      content: stripText(response["content"] as string, flag),
    };
  }

  const content = response["content"];
  if (!Array.isArray(content)) return response;

  const newContent = content
    .map((block) => {
      if (!isObject(block)) return block;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        return { ...block, text: stripText(block["text"], flag) };
      }
      return block;
    })
    .filter((block) => {
      if (!isObject(block)) return true;
      if (block["type"] === "text") {
        const text = block["text"];
        if (typeof text === "string" && text.trim().length === 0) return false;
      }
      return true;
    });

  // Anthropic stop_reason: if we stripped the signal flag AND there are no
  // tool_use blocks left, coerce to end_turn for a cleaner client experience.
  const hasToolUse = newContent.some(
    (b) => isObject(b) && b["type"] === "tool_use",
  );
  const hasVisibleText = newContent.some(
    (b) =>
      isObject(b) &&
      b["type"] === "text" &&
      typeof b["text"] === "string" &&
      b["text"].trim().length > 0,
  );

  const out: Record<string, unknown> = { ...response, content: newContent };
  if (!hasToolUse && !hasVisibleText) {
    out["stop_reason"] = "end_turn";
  }
  return out;
}

export function responseContainsFlag(
  response: Record<string, unknown>,
  terminationFlag: string,
  protocol: EnforceProtocol,
): boolean {
  if (terminationFlag.length === 0) return false;
  if (protocol === "openai") {
    const choices = response["choices"];
    if (!Array.isArray(choices)) return false;
    for (const choice of choices) {
      if (!isObject(choice)) continue;
      const message = choice["message"];
      if (!isObject(message)) continue;
      const c = message["content"];
      if (typeof c === "string" && c.includes(terminationFlag)) return true;
      if (Array.isArray(c)) {
        for (const part of c) {
          if (
            isObject(part) &&
            typeof part["text"] === "string" &&
            part["text"].includes(terminationFlag)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  if (typeof response["content"] === "string") {
    return (response["content"] as string).includes(terminationFlag);
  }
  const content = response["content"];
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    if (
      isObject(block) &&
      block["type"] === "text" &&
      typeof block["text"] === "string" &&
      block["text"].includes(terminationFlag)
    ) {
      return true;
    }
  }
  return false;
}
