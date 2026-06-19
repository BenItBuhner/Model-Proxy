import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { getStorageDir } from "./storage-paths.ts";
import { listRequestIndexRows } from "./completion-store.ts";
import type { AnalyticsSummary, RequestIndexRow, RequestLogFilters } from "./types.ts";

export function getAnalyticsSummary(filters: RequestLogFilters = {}, activeRequests = 0): AnalyticsSummary {
  const rows = listRequestIndexRows({ limit: undefined, offset: 0, filters }).records;
  const summary = summarizeRows(rows, activeRequests);
  writeFileSync(join(getStorageDir("analytics"), "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  return summary;
}

export function getAnalyticsTimeseries(filters: RequestLogFilters = {}, bucket: "hour" | "day" = "hour"): Array<{
  bucket: string;
  requests: number;
  totalTokens: number;
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
}> {
  const rows = listRequestIndexRows({ limit: undefined, offset: 0, filters }).records;
  const buckets = new Map<string, { bucket: string; requests: number; totalTokens: number; userCostUsd: number; typicalCostUsd: number; savedCostUsd: number }>();
  for (const row of rows) {
    const key = bucketKey(row.timestamp, bucket);
    const current = buckets.get(key) ?? {
      bucket: key,
      requests: 0,
      totalTokens: 0,
      userCostUsd: 0,
      typicalCostUsd: 0,
      savedCostUsd: 0,
    };
    current.requests += 1;
    current.totalTokens += row.totalTokens ?? 0;
    current.userCostUsd += row.userCostUsd;
    current.typicalCostUsd += row.typicalCostUsd;
    current.savedCostUsd += row.savedCostUsd;
    buckets.set(key, current);
  }
  return Array.from(buckets.values()).sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function summarizeRows(rows: RequestIndexRow[], activeRequests: number): AnalyticsSummary {
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
    if (row.responseStatus === undefined || row.responseStatus >= 400) failedRequests += 1;
    totalTokens += row.totalTokens ?? 0;
    promptTokens += row.promptTokens ?? 0;
    completionTokens += row.completionTokens ?? 0;
    cacheReadTokens += row.cacheReadTokens ?? 0;
    cacheCreationTokens += row.cacheCreationTokens ?? 0;
    matchedTokens += row.matchedTokens;
    if (row.isCacheHit) cacheHits += 1;
    userCostUsd += row.userCostUsd;
    typicalCostUsd += row.typicalCostUsd;
    savedCostUsd += row.savedCostUsd;
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
      totalTokens: 0,
      userCostUsd: 0,
      typicalCostUsd: 0,
      savedCostUsd: 0,
      cacheHits: 0,
    };
    group.requests += 1;
    group.totalTokens += row.totalTokens ?? 0;
    group.userCostUsd += row.userCostUsd;
    group.typicalCostUsd += row.typicalCostUsd;
    group.savedCostUsd += row.savedCostUsd;
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

function bucketKey(iso: string, bucket: "hour" | "day"): string {
  const date = new Date(iso);
  if (bucket === "day") return date.toISOString().slice(0, 10);
  return `${date.toISOString().slice(0, 13)}:00:00.000Z`;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
