import { createLogger } from "../observability/logger.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { listProviderConfigs } from "../config/provider-writer.ts";
import { upsertEnvValuesPreservingRaw } from "../config/env-writer.ts";
import { parseProviderKeys } from "./api-key-manager.ts";
import { getAvailableEgressProxies } from "./egress-proxy-manager.ts";
import { buildAuthHeaders } from "./provider-helpers.ts";
import { upstreamFetch, type UpstreamFetcher } from "./upstream-fetch.ts";

const log = createLogger("proxy-discovery");

const DEFAULT_TARGET_COUNT = 1000;
const DEFAULT_CONCURRENCY = 500;
const DEFAULT_SOURCE_LIMIT = 50000;
const SHARED_PROXY_PREFIX = "MODEL_PROXY_EGRESS_PROXY_";

const DEFAULT_SOURCES = [
  "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/https.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies_anonymous/https.txt",
  "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
  "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
  "https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt",
  "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt",
  "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt",
  "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/https.txt",
  "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt",
  "https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt",
  "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/http.txt",
  "https://raw.githubusercontent.com/ErcinDedeoglu/proxies/main/proxies/https.txt",
  "https://raw.githubusercontent.com/ALIILAPRO/Proxy/main/http.txt",
  "https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/http/http.txt",
  "https://raw.githubusercontent.com/Zaeem20/FREE_PROXIES_LIST/master/http.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
  "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt",
  "https://raw.githubusercontent.com/saschazesiger/Free-Proxies/master/proxies/http.txt",
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
  onProgress?: (progress: ProxyDiscoveryProgress) => void;
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

export interface ProxyDiscoveryProgress {
  targetCount: number;
  providers: string[];
  candidatesFetched: number;
  candidatesTested: number;
  accepted: number;
  rejectedByProvider: Record<string, number>;
  skippedProviders: Record<string, string>;
}

interface VerificationProfile {
  provider: string;
  url: string;
  method: "GET" | "POST" | "HEAD";
  successStatuses: number[];
  timeoutMs: number;
  auth: "none" | "public" | "provider_key";
  apiKey?: string;
  headers: Record<string, string>;
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
  const timeoutMs = clampPositive(options.timeoutMs, 2000);
  const providerNames = options.providers ?? enabledVerifiedProviders();
  const profiles = buildVerificationProfiles(providerNames, timeoutMs);
  const activeProfiles = profiles.filter((p): p is VerificationProfile => "url" in p);
  const skippedProviders: Record<string, string> = {};
  for (const profile of profiles) {
    if (!("url" in profile)) skippedProviders[profile.provider] = profile.reason;
  }

  const sourceUrls = options.sources ?? (options.candidates === undefined ? DEFAULT_SOURCES : []);
  const includeSharedPool = options.sources === undefined && options.candidates === undefined;
  const candidates = normalizeCandidates([
    ...(options.candidates ?? []),
    ...await fetchCandidates(sourceUrls, fetcher),
    ...(includeSharedPool ? sharedProxyEntriesFromEnv() : []),
  ]).slice(0, sourceLimit);

  const accepted: AcceptedProxy[] = [];
  const rejectedByProvider: Record<string, number> = {};
  let tested = 0;
  let cursor = 0;
  let progressTick = 0;

  const emitProgress = () => {
    options.onProgress?.({
      targetCount,
      providers: activeProfiles.map((p) => p.provider),
      candidatesFetched: candidates.length,
      candidatesTested: tested,
      accepted: accepted.length,
      rejectedByProvider: { ...rejectedByProvider },
      skippedProviders: { ...skippedProviders },
    });
  };
  emitProgress();

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
      progressTick += 1;
      if (progressTick % 50 === 0 || accepted.length >= targetCount) emitProgress();
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

  if (
    options.persist !== false &&
    activeProfiles.length > 0 &&
    report.accepted.length >= targetCount
  ) {
    report.persisted = persistSharedProxies(report.accepted.map((p) => p.url));
  } else if (options.persist !== false) {
    log.warn("proxy discovery did not meet target; leaving existing shared pool unchanged", {
      accepted: report.accepted.length,
      verifiedProviders: activeProfiles.length,
      targetCount,
    });
  }

  log.info("proxy discovery completed", {
    accepted: report.accepted.length,
    tested: report.candidatesTested,
    providers: report.providers,
  });
  emitProgress();
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
    const headers: Record<string, string> = { Accept: "application/json" };
    if (auth !== "none" && key !== undefined) {
      Object.assign(headers, buildAuthHeaders(cfg, key));
    }
    if (provider === "opencode") {
      const session = crypto.randomUUID();
      headers["x-opencode-session"] = session;
      headers["x-opencode-request"] = session;
      headers["x-opencode-client"] = "model-proxy";
      headers["User-Agent"] = "model-proxy/2.0.0";
    }
    return {
      provider,
      url,
      method: verification.method ?? "GET",
      successStatuses: verification.success_statuses ?? [200],
    timeoutMs,
      auth,
      headers,
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
      const response = await withTimeout(
        upstreamFetch(profile.url, {
          method: profile.method,
          headers: profile.headers,
          proxy,
          timeoutMs: profile.timeoutMs,
          fetcher,
        }),
        profile.timeoutMs + 1000,
        `Proxy verification timed out after ${profile.timeoutMs + 1000}ms`,
      );
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
    const res = await withTimeout(
      fetcher(url, { signal: AbortSignal.timeout(15000) }),
      16000,
      `Proxy source timed out: ${url}`,
    );
    if (!res.ok) return "";
    return await res.text();
  }));
  return settled.flatMap((result) => result.status === "fulfilled" ? extractProxyUrls(result.value) : []);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
