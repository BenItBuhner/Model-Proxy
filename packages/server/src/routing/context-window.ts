import type { ModelRoutingConfig, RouteConfig } from "@model-proxy/contracts/schemas/routing.ts";
import { modelConfigLoader } from "../config/model-loader.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { getUpstreamContextWindow } from "../config/upstream-model-catalog.ts";

/** System fallback when no upstream, route, or env value is available. */
export const SYSTEM_DEFAULT_CONTEXT_WINDOW = 128_000;

/** Context window declared by a logical model's own config (primary route
 * override first, then the model-level value). Used by the fusion pipeline
 * to budget subagent and synthesis contexts. */
export function resolveDeclaredContextWindow(modelRouting: string): number {
  try {
    const cfg = modelConfigLoader.loadConfig(modelRouting);
    const primary = cfg.model_routings[0];
    return primary?.context_window ?? cfg.context_window ?? SYSTEM_DEFAULT_CONTEXT_WINDOW;
  } catch {
    return SYSTEM_DEFAULT_CONTEXT_WINDOW;
  }
}

function envContextWindow(): number | undefined {
  const raw = process.env["DEFAULT_CONTEXT_WINDOW"];
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n;
  return undefined;
}

function asPositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** Context window from provider JSON `models.<id>.context_length` (legacy bundles). */
export function getProviderConfigContextWindow(
  providerName: string,
  upstreamModelId: string,
): number | undefined {
  try {
    const config = providerConfigLoader.loadProvider(providerName);
    const models = config.models;
    if (models === null || typeof models !== "object") return undefined;
    const entry = (models as Record<string, unknown>)[upstreamModelId];
    if (entry === null || typeof entry !== "object") return undefined;
    const record = entry as Record<string, unknown>;
    return (
      asPositiveInt(record["context_length"]) ??
      asPositiveInt(record["context_window"])
    );
  } catch {
    return undefined;
  }
}

function routeConfigContextWindow(
  route: RouteConfig | undefined,
  cfg: ModelRoutingConfig,
): number | undefined {
  return route?.context_window ?? cfg.context_window;
}

/**
 * Resolve context window for a logical model using the primary route
 * (`model_routings[0]`). Precedence: upstream catalog → provider.models JSON →
 * route/model config → DEFAULT_CONTEXT_WINDOW → 128_000.
 */
export async function resolveContextWindow(logicalModel: string): Promise<number> {
  const cfg = modelConfigLoader.loadConfig(logicalModel);
  const primary = cfg.model_routings[0];
  if (primary === undefined) {
    return envContextWindow() ?? SYSTEM_DEFAULT_CONTEXT_WINDOW;
  }

  const upstream = await getUpstreamContextWindow(primary.provider, primary.model);
  if (upstream !== undefined) return upstream;

  const providerCatalog = getProviderConfigContextWindow(
    primary.provider,
    primary.model,
  );
  if (providerCatalog !== undefined) return providerCatalog;

  const routeOverride = routeConfigContextWindow(primary, cfg);
  if (routeOverride !== undefined) return routeOverride;

  return envContextWindow() ?? SYSTEM_DEFAULT_CONTEXT_WINDOW;
}

export interface OpenAIModelListObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  context_window: number;
  context_length: number;
  limit: { context: number };
}

/**
 * Build one OpenAI-compatible /v1/models list entry with all client-facing
 * context aliases harnesses may read.
 */
export function buildOpenAIModelListEntry(
  logicalName: string,
  contextWindow: number,
  ownedBy: string,
): OpenAIModelListObject {
  return {
    id: logicalName,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: ownedBy,
    context_window: contextWindow,
    context_length: contextWindow,
    limit: { context: contextWindow },
  };
}

export async function buildLogicalModelListEntry(
  logicalName: string,
): Promise<OpenAIModelListObject> {
  let ownedBy = "unknown";
  try {
    const cfg = modelConfigLoader.loadConfig(logicalName);
    ownedBy = cfg.model_routings[0]?.provider ?? "unknown";
  } catch {
    // keep unknown
  }
  const contextWindow = await resolveContextWindow(logicalName);
  return buildOpenAIModelListEntry(logicalName, contextWindow, ownedBy);
}
