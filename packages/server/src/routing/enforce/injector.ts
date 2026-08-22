import type { EnforceProtocol } from "./types.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Appends guidance to the request's system prompt. NEVER mutates the input
 * and NEVER replaces existing system content — it only appends.
 */
export function injectGuidance(
  request: Record<string, unknown>,
  guidance: string,
  protocol: EnforceProtocol,
): Record<string, unknown> {
  if (guidance.length === 0) return request;
  if (protocol === "openai") return injectGuidanceOpenAI(request, guidance);
  return injectGuidanceAnthropic(request, guidance);
}

function injectGuidanceOpenAI(
  request: Record<string, unknown>,
  guidance: string,
): Record<string, unknown> {
  const original = Array.isArray(request["messages"])
    ? (request["messages"] as unknown[])
    : [];
  const cloned = original.map((m) =>
    isObject(m) ? { ...m, content: cloneContent(m["content"]) } : m,
  );

  const systemIndices: number[] = [];
  cloned.forEach((msg, idx) => {
    if (isObject(msg) && msg["role"] === "system") systemIndices.push(idx);
  });

  if (systemIndices.length > 0) {
    const lastIdx = systemIndices[systemIndices.length - 1];
    if (lastIdx !== undefined) {
      const sys = cloned[lastIdx] as Record<string, unknown>;
      const existing = sys["content"];
      if (typeof existing === "string") {
        sys["content"] = existing + guidance;
      } else if (Array.isArray(existing)) {
        sys["content"] = [...existing, { type: "text", text: guidance }];
      } else if (existing === null || existing === undefined) {
        sys["content"] = guidance.trimStart();
      } else {
        sys["content"] = `${String(existing)}${guidance}`;
      }
      cloned[lastIdx] = sys;
    }
  } else {
    cloned.unshift({ role: "system", content: guidance.trimStart() });
  }

  return { ...request, messages: cloned };
}

function injectGuidanceAnthropic(
  request: Record<string, unknown>,
  guidance: string,
): Record<string, unknown> {
  const existing = request["system"];
  if (typeof existing === "string") {
    return { ...request, system: existing + guidance };
  }
  if (Array.isArray(existing)) {
    return { ...request, system: [...existing, { type: "text", text: guidance }] };
  }
  if (existing === undefined || existing === null) {
    return { ...request, system: guidance.trimStart() };
  }
  return { ...request, system: `${String(existing)}${guidance}` };
}

function cloneContent(content: unknown): unknown {
  if (Array.isArray(content)) return content.map((c) => (isObject(c) ? { ...c } : c));
  return content;
}
