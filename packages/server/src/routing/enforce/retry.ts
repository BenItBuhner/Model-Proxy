import type { EnforceProtocol } from "./types.ts";

function buildRetryText(failureReason: string): string {
  return (
    "Proxy retry notice: your previous answer was rejected because it did not " +
    'contain a valid tool call object or the exact completion object {"tool_loop": "completed"}. ' +
    `Failure reason: ${failureReason}. ` +
    "Answer the original request again now. If you need a tool, return a valid tool call object. " +
    'If you are completely finished with tool use, return exactly {"tool_loop": "completed"} and nothing else.'
  );
}

const RETRY_MARKER_KEY = "__mp_enforce_retry" as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Returns a NEW request object with a fresh retry-correction message appended.
 * Strips any previous proxy-injected retry messages (so retry #3 does not carry
 * retry #1 and #2 baggage). Never mutates the input request.
 */
export function withRetryCorrection(
  request: Record<string, unknown>,
  failureReason: string,
  protocol: EnforceProtocol,
): Record<string, unknown> {
  const text = buildRetryText(failureReason);
  const original = Array.isArray(request["messages"])
    ? (request["messages"] as unknown[])
    : [];

  const cleaned = original.filter((msg) => {
    if (!isObject(msg)) return true;
    return msg[RETRY_MARKER_KEY] !== true;
  });

  const retryMessage: Record<string, unknown> =
    protocol === "openai"
      ? { role: "user", content: text, [RETRY_MARKER_KEY]: true }
      : {
          role: "user",
          content: [{ type: "text", text }],
          [RETRY_MARKER_KEY]: true,
        };

  return { ...request, messages: [...cleaned, retryMessage] };
}

/**
 * Drop the internal proxy retry marker before dispatching to the provider.
 * Some providers reject unknown top-level message fields.
 */
export function scrubRetryMarkers(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const messages = request["messages"];
  if (!Array.isArray(messages)) return request;
  const scrubbed = messages.map((msg) => {
    if (!isObject(msg)) return msg;
    if (msg[RETRY_MARKER_KEY] !== true) return msg;
    const copy = { ...msg };
    delete copy[RETRY_MARKER_KEY];
    return copy;
  });
  return { ...request, messages: scrubbed };
}
