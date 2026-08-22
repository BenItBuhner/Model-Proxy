import type { EnforceProtocol } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Convert a validated non-streaming response into SSE chunks that look like a
 * real streaming response. Supports both OpenAI and Anthropic protocols.
 */
export async function* emulateStream(
  response: Record<string, unknown>,
  protocol: EnforceProtocol,
  options: { chunkDelayMs?: number; modelFallback?: string } = {},
): AsyncGenerator<string, void, unknown> {
  const delay = options.chunkDelayMs ?? 0;

  if (protocol === "openai") {
    yield* emulateOpenAI(response, delay, options.modelFallback ?? "unknown");
  } else {
    yield* emulateAnthropic(response, delay);
  }
}

async function* emulateOpenAI(
  response: Record<string, unknown>,
  delay: number,
  modelFallback: string,
): AsyncGenerator<string, void, unknown> {
  const choices = Array.isArray(response["choices"]) ? response["choices"] : [];
  const choice = (isObject(choices[0]) ? choices[0] : {}) as Record<string, unknown>;
  const message = (isObject(choice["message"]) ? choice["message"] : {}) as Record<
    string,
    unknown
  >;
  const content = message["content"];
  const toolCalls = message["tool_calls"];
  const finishReason =
    typeof choice["finish_reason"] === "string"
      ? (choice["finish_reason"] as string)
      : Array.isArray(toolCalls) && toolCalls.length > 0
        ? "tool_calls"
        : "stop";

  const chunkId =
    typeof response["id"] === "string"
      ? (response["id"] as string)
      : `chatcmpl-${Math.floor(Date.now() / 1000)}`;
  const created =
    typeof response["created"] === "number"
      ? (response["created"] as number)
      : Math.floor(Date.now() / 1000);
  const model =
    typeof response["model"] === "string"
      ? (response["model"] as string)
      : modelFallback;

  const delta: Record<string, unknown> = { role: "assistant" };
  if (typeof content === "string" && content.length > 0) delta["content"] = content;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    delta["tool_calls"] = toolCalls;
  }

  const first = {
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  };

  const final = {
    id: chunkId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  };

  yield `data: ${JSON.stringify(first)}\n\n`;
  await sleep(delay);
  yield `data: ${JSON.stringify(final)}\n\n`;
  await sleep(delay);
  yield "data: [DONE]\n\n";
}

async function* emulateAnthropic(
  response: Record<string, unknown>,
  delay: number,
): AsyncGenerator<string, void, unknown> {
  const messageId =
    typeof response["id"] === "string"
      ? (response["id"] as string)
      : `msg_${Math.floor(Date.now() / 1000)}`;
  const model =
    typeof response["model"] === "string" ? (response["model"] as string) : "unknown";
  const usage = isObject(response["usage"]) ? response["usage"] : {};
  const stopReason =
    typeof response["stop_reason"] === "string"
      ? (response["stop_reason"] as string)
      : "end_turn";
  const contentBlocks = Array.isArray(response["content"])
    ? (response["content"] as Array<Record<string, unknown>>)
    : [];

  yield `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  })}\n\n`;
  await sleep(delay);

  for (let i = 0; i < contentBlocks.length; i++) {
    const block = contentBlocks[i];
    if (!isObject(block)) continue;
    yield `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: i,
      content_block: block,
    })}\n\n`;
    await sleep(delay);
    yield `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: i,
    })}\n\n`;
    await sleep(delay);
  }

  yield `event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage,
  })}\n\n`;
  await sleep(delay);
  yield `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
}
