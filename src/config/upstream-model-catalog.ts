import { createLogger } from "../observability/logger.ts";
import { providerConfigLoader } from "./provider-loader.ts";
import { getAvailableKeys } from "../providers/api-key-manager.ts";
import {
  buildAuthHeaders,
  getProviderWireProtocol,
} from "../providers/provider-helpers.ts";

const log = createLogger("config.upstream-models");

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const CACHE_TTL_MS = envNumber("UPSTREAM_MODELS_CACHE_TTL_SECONDS", 3600) * 1000;
const FETCH_TIMEOUT_MS = envNumber("UPSTREAM_MODELS_FETCH_TIMEOUT_MS", 2000);

interface ProviderCacheEntry {
  fetchedAtMs: number;
  modelsById: Map<string, number>;
  inFlight: Promise<void> | undefined;
}

const cacheByProvider = new Map<string, ProviderCacheEntry>();

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

/** Parse context tokens from an upstream /v1/models list item (OpenCursor-compatible). */
export function parseContextFromModelItem(
  item: Record<string, unknown>,
): number | undefined {
  const direct = asPositiveInt(item["context_window"]);
  if (direct !== undefined) return direct;

  const limit = item["limit"];
  if (limit !== null && typeof limit === "object") {
    const fromLimit = asPositiveInt((limit as Record<string, unknown>)["context"]);
    if (fromLimit !== undefined) return fromLimit;
  }

  return asPositiveInt(item["context_length"]);
}

function substituteEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? `\${${varName}}`;
  });
}

function resolveBaseUrl(providerName: string): string | undefined {
  try {
    const config = providerConfigLoader.loadProvider(providerName);
    let base = config.endpoints.base_url;
    if (config.proxy_support?.enabled === true) {
      const overrideUrl = config.proxy_support.base_url_override;
      if (typeof overrideUrl === "string" && overrideUrl.length > 0) {
        base = overrideUrl;
      }
    }
    return substituteEnvVars(base).replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** Build the provider models list URL (OpenCursor-compatible rules). */
export function resolveModelsListUrl(
  baseUrl: string,
  wireProtocol: "openai" | "anthropic" | "responses",
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (wireProtocol === "anthropic") {
    return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
  }
  if (trimmed.endsWith("/v1")) {
    return `${trimmed}/models`;
  }
  if (/\/v\d+$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function parseModelsPayload(payload: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const root =
    payload !== null && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : undefined;
  const data = Array.isArray(root?.["data"])
    ? root["data"]
    : Array.isArray(payload)
      ? payload
      : [];

  for (const raw of data) {
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = item["id"];
    if (typeof id !== "string" || id.length === 0) continue;
    const ctx = parseContextFromModelItem(item);
    if (ctx !== undefined) out.set(id, ctx);
  }
  return out;
}

async function fetchProviderCatalog(providerName: string): Promise<Map<string, number>> {
  const baseUrl = resolveBaseUrl(providerName);
  if (baseUrl === undefined) return new Map();

  const keys = getAvailableKeys(providerName);
  if (keys.length === 0) {
    log.debug("skip upstream models fetch: no API keys", { provider: providerName });
    return new Map();
  }

  let config;
  try {
    config = providerConfigLoader.loadProvider(providerName);
  } catch (err) {
    log.warn("upstream models fetch: provider config missing", {
      provider: providerName,
      err: String(err),
    });
    return new Map();
  }

  const wireProtocol = getProviderWireProtocol(providerName);
  const url = resolveModelsListUrl(baseUrl, wireProtocol);
  const headers = buildAuthHeaders(config, keys[0]!);
  headers["Accept"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    if (response.status >= 400) {
      const body = await response.text().catch(() => "");
      log.warn("upstream models fetch failed", {
        provider: providerName,
        status: response.status,
        body: body.slice(0, 200),
      });
      return new Map();
    }
    const payload = await response.json();
    return parseModelsPayload(payload);
  } catch (err) {
    log.debug("upstream models fetch error", {
      provider: providerName,
      err: String(err),
    });
    return new Map();
  } finally {
    clearTimeout(timer);
  }
}

function getOrCreateEntry(providerName: string): ProviderCacheEntry {
  const existing = cacheByProvider.get(providerName);
  if (existing !== undefined) return existing;
  const fresh: ProviderCacheEntry = {
    fetchedAtMs: 0,
    modelsById: new Map(),
    inFlight: undefined,
  };
  cacheByProvider.set(providerName, fresh);
  return fresh;
}

function isStale(entry: ProviderCacheEntry): boolean {
  if (entry.fetchedAtMs === 0) return true;
  return Date.now() - entry.fetchedAtMs >= CACHE_TTL_MS;
}

function scheduleRefresh(providerName: string): void {
  const entry = getOrCreateEntry(providerName);
  if (entry.inFlight !== undefined) return;

  entry.inFlight = (async () => {
    try {
      const models = await fetchProviderCatalog(providerName);
      entry.modelsById = models;
      entry.fetchedAtMs = Date.now();
    } finally {
      entry.inFlight = undefined;
    }
  })();
}

/**
 * Look up context window for an upstream model id from the provider's cached
 * /v1/models list. Refreshes stale caches in the background; optionally waits
 * up to UPSTREAM_MODELS_FETCH_TIMEOUT_MS on first populate.
 */
export async function getUpstreamContextWindow(
  providerName: string,
  upstreamModelId: string,
): Promise<number | undefined> {
  const entry = getOrCreateEntry(providerName);
  const cached = entry.modelsById.get(upstreamModelId);
  if (cached !== undefined && !isStale(entry)) {
    return cached;
  }

  if (isStale(entry)) {
    scheduleRefresh(providerName);
    if (entry.inFlight !== undefined) {
      const timeout = new Promise<void>((resolve) =>
        setTimeout(resolve, FETCH_TIMEOUT_MS),
      );
      await Promise.race([entry.inFlight, timeout]);
    }
    return entry.modelsById.get(upstreamModelId);
  }

  return cached;
}

/** Reset in-memory catalog (tests). */
export function clearUpstreamModelCatalogCache(): void {
  cacheByProvider.clear();
}
