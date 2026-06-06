import { createLogger } from "../observability/logger.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { listProviderConfigs } from "../config/provider-writer.ts";
import { upsertEnvValuesPreservingRaw } from "../config/env-writer.ts";
import { parseProviderKeys } from "./api-key-manager.ts";
import { getAvailableEgressProxies } from "./egress-proxy-manager.ts";
import { upstreamFetch, type UpstreamFetcher } from "./upstream-fetch.ts";

const log = createLogger("proxy-discovery");

const DEFAULT_TARGET_COUNT = 50;
const DEFAULT_CONCURRENCY = 20;
const DEFAULT_SOURCE_LIMIT = 5000;
const SHARED_PROXY_PREFIX = "MODEL_PROXY_EGRESS_PROXY_";

const DEFAULT_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
  "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
];

export interface ProxyDiscoveryOptions {
  targetCount?: number;
  providers?: string[];
  persist?: boolean;
  timeoutMs?: number;
  concurrency?: number;
  sourceLimit?: number;
  sources?: string[];
  fetcher?: UpstreamFetcher;
  candidates?: string[];
}

export interface ProviderVerificationResult {
  provider: string;
  status: "passed" | "failed" | "skipped_missing_key" | "skipped_disabled";
  httpStatus?: number;
  error?: string;
  durationMs?: number;
}

export interface AcceptedProxy {
  url: string;
  providers: ProviderVerificationResult[];
}

export interface ProxyDiscoveryReport {
  targetCount: number;
  providers: string[];
  candidatesFetched: number;
  candidatesTested: number;
  accepted: AcceptedProxy[];
  rejectedByProvider: Record<string, number>;
  skippedProviders: Record<string, string>;
  persisted?: { path: string; applied: number; removed: string[] };
}

interface VerificationProfile {
  provider: string;
  url: string;
  method: "GET" | "POST" | "HEAD";
  successStatuses: number[];
  timeoutMs: number;
  auth: "none" | "public" | "provider_key";
  apiKey?: string;
}

export function currentProxyStatus(providerNames?: string[]): {
  providers: Array<{ provider: string; enabled: boolean; proxyCount: number; proxies: string[] }>;
  shared: string[];
} {
  const names = providerNames ?? listProviderConfigs().map((p) => p.name);
  const shared = sharedProxyEntriesFromEnv();
  return {
    shared,
    providers: names.map((provider) => {
      let enabled = false;
      try {
        enabled = providerConfigLoader.loadProvider(provider).egress_proxies?.enabled === true;
      } catch {
        enabled = false;
      }
      const proxies = getAvailableEgressProxies(provider).map((p) => p.url);
      return { provider, enabled, proxyCount: proxies.length, proxies };
    }),
  };
}

export async function discoverProxies(
  options: ProxyDiscoveryOptions = {},
): Promise<ProxyDiscoveryReport> {
  const targetCount = clampPositive(options.targetCount, DEFAULT_TARGET_COUNT);
  const concurrency = clampPositive(options.concurrency, DEFAULT_CONCURRENCY);
  const sourceLimit = clampPositive(options.sourceLimit, DEFAULT_SOURCE_LIMIT);
  const fetcher: UpstreamFetcher = options.fetcher ?? fetch;
  const timeoutMs = clampPositive(options.timeoutMs, 15000);
  const providerNames = options.providers ?? enabledVerifiedProviders();
  const profiles = buildVerificationProfiles(providerNames, timeoutMs);
  const activeProfiles = profiles.filter((p): p is VerificationProfile => "url" in p);
  const skippedProviders: Record<string, string> = {};
  for (const profile of profiles) {
    if (!("url" in profile)) skippedProviders[profile.provider] = profile.reason;
  }

  const candidates = normalizeCandidates([
    ...(options.candidates ?? []),
    ...await fetchCandidates(options.sources ?? DEFAULT_SOURCES, fetcher),
    ...sharedProxyEntriesFromEnv(),
  ]).slice(0, sourceLimit);

  const accepted: AcceptedProxy[] = [];
  const rejectedByProvider: Record<string, number> = {};
  let tested = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (accepted.length < targetCount && cursor < candidates.length) {
      const candidate = candidates[cursor++];
      if (candidate === undefined) break;
      tested += 1;
      const results = await verifyProxyForProfiles(candidate, activeProfiles, fetcher);
      const failed = results.find((r) => r.status !== "passed");
      if (failed === undefined) {
        accepted.push({ url: candidate, providers: results });
      } else {
        rejectedByProvider[failed.provider] = (rejectedByProvider[failed.provider] ?? 0) + 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));

  const report: ProxyDiscoveryReport = {
    targetCount,
    providers: activeProfiles.map((p) => p.provider),
    candidatesFetched: candidates.length,
    candidatesTested: tested,
    accepted: accepted.slice(0, targetCount),
    rejectedByProvider,
    skippedProviders,
  };

  if (options.persist !== false && report.accepted.length > 0) {
    report.persisted = persistSharedProxies(report.accepted.map((p) => p.url));
  }

  log.info("proxy discovery completed", {
    accepted: report.accepted.length,
    tested: report.candidatesTested,
    providers: report.providers,
  });
  return report;
}

function enabledVerifiedProviders(): string[] {
  return listProviderConfigs()
    .filter((item) => {
      try {
        const cfg = providerConfigLoader.loadProvider(item.name);
        return cfg.enabled === true && cfg.egress_proxies?.enabled === true && cfg.egress_proxies.verification?.enabled === true;
      } catch {
        return false;
      }
    })
    .map((item) => item.name);
}

type ProfileOrSkip = VerificationProfile | { provider: string; reason: string };

function buildVerificationProfiles(providers: string[], timeoutMs: number): ProfileOrSkip[] {
  return providers.map((provider) => {
    const cfg = providerConfigLoader.loadProvider(provider);
    const verification = cfg.egress_proxies?.verification;
    if (cfg.egress_proxies?.enabled !== true || verification?.enabled !== true) {
      return { provider, reason: "verification_disabled" };
    }
    const auth = verification.auth ?? "provider_key";
    const key = auth === "public" ? "public" : auth === "provider_key" ? parseProviderKeys(provider)[0] : undefined;
    if (auth === "provider_key" && (key === undefined || key.length === 0)) {
      return { provider, reason: "missing_api_key" };
    }
    const url = verification.url ?? `${cfg.endpoints.base_url.replace(/\/$/, "")}${cfg.endpoints.completions}`;
    return {
      provider,
      url,
      method: verification.method ?? "GET",
      successStatuses: verification.success_statuses ?? [200],
      timeoutMs: verification.timeout_ms ?? timeoutMs,
      auth,
      ...(key !== undefined ? { apiKey: key } : {}),
    };
  });
}

async function verifyProxyForProfiles(
  proxy: string,
  profiles: VerificationProfile[],
  fetcher: UpstreamFetcher,
): Promise<ProviderVerificationResult[]> {
  const out: ProviderVerificationResult[] = [];
  for (const profile of profiles) {
    const started = performance.now();
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (profile.auth !== "none" && profile.apiKey !== undefined) {
        headers.Authorization = `Bearer ${profile.apiKey}`;
      }
      const response = await upstreamFetch(profile.url, {
        method: profile.method,
        headers,
        proxy,
        timeoutMs: profile.timeoutMs,
        fetcher,
      });
      const durationMs = Math.round(performance.now() - started);
      if (profile.successStatuses.includes(response.status)) {
        out.push({ provider: profile.provider, status: "passed", httpStatus: response.status, durationMs });
      } else {
        out.push({ provider: profile.provider, status: "failed", httpStatus: response.status, durationMs });
        break;
      }
    } catch (err) {
      out.push({
        provider: profile.provider,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        durationMs: Math.round(performance.now() - started),
      });
      break;
    }
  }
  return out;
}

async function fetchCandidates(sources: string[], fetcher: UpstreamFetcher): Promise<string[]> {
  const settled = await Promise.allSettled(sources.map(async (url) => {
    const res = await fetcher(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return "";
    return await res.text();
  }));
  return settled.flatMap((result) => result.status === "fulfilled" ? extractProxyUrls(result.value) : []);
}

function extractProxyUrls(text: string): string[] {
  const matches = text.match(/(?:https?:\/\/)?(?:\d{1,3}\.){3}\d{1,3}:\d{2,5}/g) ?? [];
  return matches;
}

function normalizeCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function sharedProxyEntriesFromEnv(): string[] {
  const entries = Object.entries(process.env)
    .filter(([key, value]) => key.startsWith(SHARED_PROXY_PREFIX) && value !== undefined && value.length > 0)
    .sort(([a], [b]) => envIndex(a) - envIndex(b));
  return entries.map(([, value]) => value as string);
}

function persistSharedProxies(proxies: string[]): { path: string; applied: number; removed: string[] } {
  const updates: Record<string, string> = {};
  proxies.forEach((proxy, index) => {
    updates[`${SHARED_PROXY_PREFIX}${index + 1}`] = proxy;
  });
  return upsertEnvValuesPreservingRaw(updates, { removePrefixes: [SHARED_PROXY_PREFIX] });
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

function envIndex(key: string): number {
  return Number.parseInt(key.match(/_(\d+)$/)?.[1] ?? "0", 10);
}
