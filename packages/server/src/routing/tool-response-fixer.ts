/**
 * Helpers to auto-inject empty tool responses when providers reject requests
 * because tool_calls have no matching tool messages. Port of
 * `_fix_missing_tool_responses` / `_fix_missing_tool_results_anthropic`.
 */

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fixMissingToolResponsesOpenAI(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const messages = request["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return request;

  const fixed: Array<Record<string, unknown>> = [];
  const pending: string[] = [];

  const flushPending = () => {
    for (const tcId of pending) {
      fixed.push({ role: "tool", tool_call_id: tcId, content: "" });
    }
    pending.length = 0;
  };

  for (const msg of messages) {
    if (!isObject(msg)) {
      flushPending();
      fixed.push(msg as Record<string, unknown>);
      continue;
    }
    if (msg["role"] === "assistant" && Array.isArray(msg["tool_calls"])) {
      flushPending();
      fixed.push(msg);
      for (const tc of msg["tool_calls"] as unknown[]) {
        if (isObject(tc) && typeof tc["id"] === "string") {
          pending.push(tc["id"]);
        }
      }
    } else if (msg["role"] === "tool") {
      const tcId = msg["tool_call_id"];
      if (typeof tcId === "string") {
        const idx = pending.indexOf(tcId);
        if (idx !== -1) pending.splice(idx, 1);
      }
      fixed.push(msg);
    } else {
      flushPending();
      fixed.push(msg);
    }
  }
  flushPending();

  return { ...request, messages: fixed };
}

export function fixMissingToolResultsAnthropic(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const messages = request["messages"];
  if (!Array.isArray(messages) || messages.length === 0) return request;

  const fixed: Array<Record<string, unknown>> = [];
  let pending: string[] = [];

  const extractToolUseIds = (content: unknown): string[] => {
    if (!Array.isArray(content)) return [];
    const ids: string[] = [];
    for (const block of content) {
      if (isObject(block) && block["type"] === "tool_use") {
        const id = block["id"];
        if (typeof id === "string") ids.push(id);
      }
    }
    return ids;
  };

  const extractToolResultIds = (content: unknown): string[] => {
    if (!Array.isArray(content)) return [];
    const ids: string[] = [];
    for (const block of content) {
      if (isObject(block) && block["type"] === "tool_result") {
        const id = block["tool_use_id"];
        if (typeof id === "string") ids.push(id);
      }
    }
    return ids;
  };

  const makeToolResultMessage = (ids: string[]): Record<string, unknown> => ({
    role: "user",
    content: ids.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "",
      is_error: false,
    })),
  });

  for (const raw of messages) {
    if (!isObject(raw)) continue;
    const role = raw["role"];
    const content = raw["content"];

    if (role === "assistant") {
      if (pending.length > 0) {
        fixed.push(makeToolResultMessage(pending));
        pending = [];
      }
      fixed.push(raw);
      pending = extractToolUseIds(content);
      continue;
    }
    if (role === "user") {
      if (pending.length > 0) {
        const resolved = new Set(extractToolResultIds(content));
        const missing = pending.filter((id) => !resolved.has(id));
        if (missing.length > 0) fixed.push(makeToolResultMessage(missing));
        pending = [];
      }
      fixed.push(raw);
      continue;
    }
    if (pending.length > 0) {
      fixed.push(makeToolResultMessage(pending));
      pending = [];
    }
    fixed.push(raw);
  }

  if (pending.length > 0) {
    fixed.push(makeToolResultMessage(pending));
  }

  return { ...request, messages: fixed };
}
