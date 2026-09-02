import { calculateCosts, resolvePricing } from "../observability/pricing.ts";
import type { UsageSnapshot } from "../observability/usage.ts";
import { registerStorageRootReset } from "./storage-paths.ts";
import { listRequestMetricRows, metricsStoreFingerprint } from "./metrics-store.ts";
import type { AnalyticsSummary, RequestLogFilters, RequestMetricRow } from "./types.ts";

const summaryCache = new Map<string, { fingerprint: string; activeRequests: number; summary: AnalyticsSummary }>();
const timeseriesCache = new Map<string, { fingerprint: string; points: AnalyticsTimeseriesPoint[] }>();

registerStorageRootReset(() => {
  summaryCache.clear();
  timeseriesCache.clear();
});

function filterCacheKey(filters: RequestLogFilters): string {
  return JSON.stringify({
    provider: filters.provider,
    model: filters.model,
    apiKeyEnvVar: filters.apiKeyEnvVar,
    userId: filters.userId,
    apiKeyId: filters.apiKeyId,
    state: filters.state,
    cacheHit: filters.cacheHit,
    status: filters.status,
    since: filters.since,
    until: filters.until,
  });
}

export function getAnalyticsSummary(filters: RequestLogFilters = {}, activeRequests = 0): AnalyticsSummary {
  const fingerprint = metricsStoreFingerprint();
  const cacheKey = filterCacheKey(filters);
  const cached = summaryCache.get(cacheKey);
  if (cached !== undefined && cached.fingerprint === fingerprint && cached.activeRequests === activeRequests) {
    return cached.summary;
  }
  const rows = listRequestMetricRows({ limit: undefined, offset: 0, filters }).records;
  const summary = summarizeRows(rows, activeRequests);
  summaryCache.set(cacheKey, { fingerprint, activeRequests, summary });
  return summary;
}

export interface AnalyticsTimeseriesPoint {
  bucket: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
}

export function getAnalyticsTimeseries(
  filters: RequestLogFilters = {},
  bucket: "hour" | "day" = "hour",
): AnalyticsTimeseriesPoint[] {
  const fingerprint = metricsStoreFingerprint();
  const cacheKey = `${filterCacheKey(filters)}|${bucket}`;
  const cached = timeseriesCache.get(cacheKey);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return cached.points;
  }
  const rows = listRequestMetricRows({ limit: undefined, offset: 0, filters }).records;
  const buckets = new Map<string, AnalyticsTimeseriesPoint>();
  for (const row of rows) {
    const costs = costsForRow(row);
    const key = bucketKey(row.timestamp, bucket);
    const current = buckets.get(key) ?? {
      bucket: key,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      userCostUsd: 0,
      typicalCostUsd: 0,
      savedCostUsd: 0,
    };
    current.requests += 1;
    current.promptTokens += row.promptTokens ?? 0;
    current.completionTokens += row.completionTokens ?? 0;
    current.totalTokens += row.totalTokens ?? 0;
    current.userCostUsd += costs.userCostUsd;
    current.typicalCostUsd += costs.typicalCostUsd;
    current.savedCostUsd += costs.savedCostUsd;
    buckets.set(key, current);
  }
  const points = Array.from(buckets.values())
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map((point) => ({
      ...point,
      userCostUsd: roundMoney(point.userCostUsd),
      typicalCostUsd: roundMoney(point.typicalCostUsd),
      savedCostUsd: roundMoney(point.savedCostUsd),
    }));
  timeseriesCache.set(cacheKey, { fingerprint, points });
  return points;
}

function summarizeRows(rows: RequestMetricRow[], activeRequests: number): AnalyticsSummary {
  let failedRequests = 0;
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let matchedTokens = 0;
  let cacheHits = 0;
  let userCostUsd = 0;
  let typicalCostUsd = 0;
  let savedCostUsd = 0;
  const latencies: number[] = [];
  const speeds: number[] = [];
  const byKey = new Map<string, AnalyticsSummary["byProviderKey"][number]>();

  for (const row of rows) {
    const costs = costsForRow(row);
    if (row.responseStatus === undefined || row.responseStatus >= 400) failedRequests += 1;
    totalTokens += row.totalTokens ?? 0;
    promptTokens += row.promptTokens ?? 0;
    completionTokens += row.completionTokens ?? 0;
    cacheReadTokens += row.cacheReadTokens ?? 0;
    cacheCreationTokens += row.cacheCreationTokens ?? 0;
    matchedTokens += row.matchedTokens;
    if (row.isCacheHit) cacheHits += 1;
    userCostUsd += costs.userCostUsd;
    typicalCostUsd += costs.typicalCostUsd;
    savedCostUsd += costs.savedCostUsd;
    if (row.responseTimeMs !== undefined) latencies.push(row.responseTimeMs);
    if ((row.completionTokens ?? 0) > 0 && row.responseTimeMs !== undefined && row.responseTimeMs > 0) {
      speeds.push((row.completionTokens ?? 0) / (row.responseTimeMs / 1000));
    }
    const key = `${row.resolvedProvider ?? "-"}|${row.apiKeyEnvVar ?? "-"}|${row.resolvedModel ?? "-"}`;
    const group = byKey.get(key) ?? {
      provider: row.resolvedProvider ?? "-",
      apiKeyEnvVar: row.apiKeyEnvVar ?? "-",
      model: row.resolvedModel ?? "-",
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      matchedTokens: 0,
      userCostUsd: 0,
      typicalCostUsd: 0,
      savedCostUsd: 0,
      cacheHits: 0,
    };
    group.requests += 1;
    group.promptTokens += row.promptTokens ?? 0;
    group.completionTokens += row.completionTokens ?? 0;
    group.totalTokens += row.totalTokens ?? 0;
    group.cacheReadTokens += row.cacheReadTokens ?? 0;
    group.cacheCreationTokens += row.cacheCreationTokens ?? 0;
    group.matchedTokens += row.matchedTokens;
    group.userCostUsd += costs.userCostUsd;
    group.typicalCostUsd += costs.typicalCostUsd;
    group.savedCostUsd += costs.savedCostUsd;
    if (row.isCacheHit) group.cacheHits += 1;
    byKey.set(key, group);
  }

  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  return {
    totalRequests: rows.length + activeRequests,
    completedRequests: rows.length,
    failedRequests,
    activeRequests,
    totalTokens,
    promptTokens,
    completionTokens,
    cacheReadTokens,
    cacheCreationTokens,
    matchedTokens,
    cacheHits,
    userCostUsd: roundMoney(userCostUsd),
    typicalCostUsd: roundMoney(typicalCostUsd),
    savedCostUsd: roundMoney(savedCostUsd),
    avgLatencyMs: average(latencies),
    p95LatencyMs:
      sortedLatencies.length > 0
        ? sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * 0.95))]
        : undefined,
    avgTokensPerSecond: average(speeds),
    byProviderKey: Array.from(byKey.values())
      .sort((a, b) => b.requests - a.requests)
      .map((group) => ({
        ...group,
        userCostUsd: roundMoney(group.userCostUsd),
        typicalCostUsd: roundMoney(group.typicalCostUsd),
        savedCostUsd: roundMoney(group.savedCostUsd),
      })),
  };
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function costsForRow(row: RequestMetricRow): {
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
} {
  if (
    row.userCostUsd !== 0 ||
    row.typicalCostUsd !== 0 ||
    row.savedCostUsd !== 0 ||
    (row.totalTokens ?? 0) <= 0
  ) {
    return {
      userCostUsd: row.userCostUsd,
      typicalCostUsd: row.typicalCostUsd,
      savedCostUsd: row.savedCostUsd,
    };
  }
  return calculateCosts(usageFromRow(row), resolvePricing({
    requestedModel: row.requestedModel,
    resolvedProvider: row.resolvedProvider,
    resolvedModel: row.resolvedModel,
    apiKeyEnvVar: row.apiKeyEnvVar,
  }));
}

function usageFromRow(row: RequestMetricRow): UsageSnapshot {
  return {
    promptTokens: row.promptTokens,
    promptTokensEstimated: row.promptTokensEstimated ?? false,
    completionTokens: row.completionTokens,
    completionTokensEstimated: row.completionTokensEstimated ?? false,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cachedTokens: row.cachedTokens,
  };
}

function bucketKey(iso: string, bucket: "hour" | "day"): string {
  const date = new Date(iso);
  if (bucket === "day") return date.toISOString().slice(0, 10);
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
