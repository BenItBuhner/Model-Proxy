"use client";

import type {
  ThreadMessage,
  ThreadMessageAnthropic,
  ThreadMessageOpenAI,
} from "./test-session";

/**
 * Build an assistant `ThreadMessage` from the proxy's non-streaming response
 * body. Used to append the model's turn to the conversation after a round
 * trip (and to surface any tool-calls it emitted).
 */
export function extractAssistantMessage(
  protocol: "openai" | "anthropic",
  response: Record<string, unknown>,
): ThreadMessage | undefined {
  if (protocol === "openai") return extractOpenAIAssistant(response);
  return extractAnthropicAssistant(response);
}

function extractOpenAIAssistant(
  response: Record<string, unknown>,
): ThreadMessageOpenAI | undefined {
  const choices = response["choices"];
  if (!Array.isArray(choices)) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return undefined;
  const msg = message as Record<string, unknown>;
  const raw = msg["content"];
  const content: string | null =
    typeof raw === "string" ? raw : raw === null ? null : "";

  const out: ThreadMessageOpenAI = {
    role: "assistant",
    content,
  };
  const toolCalls = msg["tool_calls"];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    out.tool_calls = toolCalls.map((raw) => {
      const tc = raw as Record<string, unknown>;
      const fn = (tc["function"] as Record<string, unknown>) ?? {};
      return {
        id: String(tc["id"] ?? ""),
        type: "function" as const,
        function: {
          name: String(fn["name"] ?? ""),
          arguments:
            typeof fn["arguments"] === "string"
              ? (fn["arguments"] as string)
              : JSON.stringify(fn["arguments"] ?? {}),
        },
      };
    });
  }
  return out;
}

function extractAnthropicAssistant(
  response: Record<string, unknown>,
): ThreadMessageAnthropic | undefined {
  const content = response["content"];
  if (!Array.isArray(content)) {
    if (typeof content === "string") {
      return { role: "assistant", content };
    }
    return undefined;
  }
  return {
    role: "assistant",
    content: content.filter((b) => b !== null && typeof b === "object") as ThreadMessageAnthropic["content"],
  };
}

/** True if the assistant message contains any pending tool call awaiting a result. */
export function hasPendingToolCalls(
  protocol: "openai" | "anthropic",
  msg: ThreadMessage,
): boolean {
  if (protocol === "openai") {
    const m = msg as ThreadMessageOpenAI;
    return Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
  }
  const m = msg as ThreadMessageAnthropic;
  if (!Array.isArray(m.content)) return false;
  return m.content.some((b) => b.type === "tool_use");
}

/** Accumulate streaming OpenAI deltas into a single assistant message. */
export function mergeOpenAIDeltas(
  accumulated: ThreadMessageOpenAI,
  delta: Record<string, unknown>,
): ThreadMessageOpenAI {
  const next: ThreadMessageOpenAI = {
    role: "assistant",
    content: accumulated.content ?? "",
  };
  if (accumulated.tool_calls !== undefined) next.tool_calls = [...accumulated.tool_calls];

  const content = delta["content"];
  if (typeof content === "string") {
    next.content = (typeof next.content === "string" ? next.content : "") + content;
  }

  const tcs = delta["tool_calls"];
  if (Array.isArray(tcs)) {
    next.tool_calls ??= [];
    for (const raw of tcs) {
      const tc = raw as Record<string, unknown>;
      const index =
        typeof tc["index"] === "number"
          ? (tc["index"] as number)
          : next.tool_calls.length;
      if (next.tool_calls[index] === undefined) {
        next.tool_calls[index] = {
          id: String(tc["id"] ?? ""),
          type: "function",
          function: { name: "", arguments: "" },
        };
      }
      const target = next.tool_calls[index] as NonNullable<
        ThreadMessageOpenAI["tool_calls"]
      >[number];
      if (typeof tc["id"] === "string" && (tc["id"] as string).length > 0) {
        target.id = tc["id"] as string;
      }
      const fn = tc["function"] as Record<string, unknown> | undefined;
      if (fn !== undefined) {
        if (typeof fn["name"] === "string") target.function.name += fn["name"];
        if (typeof fn["arguments"] === "string")
          target.function.arguments += fn["arguments"];
      }
    }
  }
  return next;
}
