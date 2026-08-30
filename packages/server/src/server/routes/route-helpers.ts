import type { Context } from "hono";

import type { Principal } from "../../storage/identity-store.ts";

/**
 * Helpers shared by the OpenAI and Anthropic route pipelines (request
 * plumbing that is protocol-agnostic).
 */

/** Forward the opencode/zen affinity headers plus the caller's user agent. */
export function buildUpstreamExtraHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  const session = c.req.header("x-opencode-session") ?? c.req.header("x-session-affinity");
  if (session !== undefined && session.length > 0) headers["x-opencode-session"] = session;
  const opencodeRequest = c.req.header("x-opencode-request");
  if (opencodeRequest !== undefined && opencodeRequest.length > 0) {
    headers["x-opencode-request"] = opencodeRequest;
  }
  const opencodeClient = c.req.header("x-opencode-client");
  if (opencodeClient !== undefined && opencodeClient.length > 0) {
    headers["x-opencode-client"] = opencodeClient;
  }
  const project = c.req.header("x-opencode-project");
  if (project !== undefined && project.length > 0) headers["x-opencode-project"] = project;
  const userAgent = c.req.header("user-agent");
  if (userAgent !== undefined && userAgent.length > 0) headers["User-Agent"] = userAgent;
  return headers;
}

export function shouldPersistCompletion(modelOverride: boolean | undefined): boolean {
  if (modelOverride !== undefined) return modelOverride;
  return /^(1|true|yes|on)$/i.test(process.env.PERSIST_COMPLETIONS?.trim() ?? "");
}

/**
 * Owners follow the model-level persistence override; regular users only get
 * completion logging when their account explicitly enables it.
 */
export function completionPersistenceForRequest(
  p: Principal | undefined,
  modelOverride: boolean | undefined,
): boolean | undefined {
  if (p === undefined || p.isOwner) return modelOverride;
  return p.completionLoggingEnabled === true;
}

export function fusionUsageFromTrace(trace: Record<string, unknown> | undefined): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} | undefined {
  const costs = trace?.["costs"];
  if (!Array.isArray(costs) || costs.length === 0) return undefined;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  for (const entry of costs) {
    if (typeof entry !== "object" || entry === null) continue;
    const cost = entry as Record<string, unknown>;
    promptTokens += typeof cost["promptTokens"] === "number" ? cost["promptTokens"] : 0;
    completionTokens += typeof cost["completionTokens"] === "number" ? cost["completionTokens"] : 0;
    totalTokens += typeof cost["totalTokens"] === "number" ? cost["totalTokens"] : 0;
  }
  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}
