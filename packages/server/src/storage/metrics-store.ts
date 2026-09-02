import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

import { getStorageDir, registerStorageRootReset } from "./storage-paths.ts";
import type { RequestLogRecord } from "../observability/ring-buffer.ts";
import type { RequestLogFilters, RequestMetricRow } from "./types.ts";

interface MetricsFileCache {
  mtimeMs: number;
  size: number;
  rows: RequestMetricRow[];
}

const metricsFileCache = new Map<string, MetricsFileCache>();
let cachedStorageDir: string | undefined;
let allRowsCache: RequestMetricRow[] | undefined;
let allRowsFingerprint: string | undefined;

export function writeRequestMetric(record: RequestLogRecord): RequestMetricRow {
  const row = metricRowFromRecord(record);
  const completed = row.completedAt ?? row.timestamp;
  const date = new Date(completed);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dir = getStorageDir("metrics");
  const path = join(dir, `requests-${year}-${month}-${day}.jsonl`);
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  const cached = metricsFileCache.get(path);
  if (cached !== undefined) {
    try {
      const stat = statSync(path);
      if (stat.size >= cached.size) {
        cached.rows.push(row);
        cached.mtimeMs = stat.mtimeMs;
        cached.size = stat.size;
        if (allRowsCache !== undefined) {
          allRowsCache.push(row);
          allRowsFingerprint = metricsStoreFingerprint();
        }
      } else {
        metricsFileCache.delete(path);
        allRowsCache = undefined;
        allRowsFingerprint = undefined;
      }
    } catch {
      metricsFileCache.delete(path);
      allRowsCache = undefined;
      allRowsFingerprint = undefined;
    }
  }
  return row;
}

export function listRequestMetricRows({
  limit,
  offset = 0,
  filters = {},
  newestFirst = true,
}: {
  limit?: number;
  offset?: number;
  filters?: RequestLogFilters;
  newestFirst?: boolean;
}): { records: RequestMetricRow[]; total: number } {
  const filtered = readAllMetricRows().filter((row) => matchesFilters(row, filters));
  const rows = newestFirst ? filtered.sort(compareNewestFirst) : filtered;
  return {
    records: limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit),
    total: rows.length,
  };
}

export function resetMetricsCacheForTests(): void {
  metricsFileCache.clear();
  cachedStorageDir = undefined;
  allRowsCache = undefined;
  allRowsFingerprint = undefined;
}

registerStorageRootReset(resetMetricsCacheForTests);

export function warmupMetricsCache(): number {
  return readAllMetricRows().length;
}

export function metricsStoreFingerprint(): string {
  const dir = getStorageDir("metrics");
  if (!existsSync(dir)) return `${dir}|missing`;
  const parts: string[] = [dir];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    try {
      const stat = statSync(path);
      parts.push(`${file}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${file}:gone`);
    }
  }
  return parts.sort().join("|");
}

function metricRowFromRecord(record: RequestLogRecord): RequestMetricRow {
  return {
    version: 1,
    requestId: record.requestId,
    timestamp: record.timestamp,
    completedAt: record.completedAt,
    endpoint: record.endpoint,
    method: record.method,
    requestedModel: record.requestedModel,
    resolvedProvider: record.resolvedProvider,
    resolvedModel: record.resolvedModel,
    wireProtocol: record.wireProtocol,
    apiKeyEnvVar: record.apiKeyEnvVar,
    keyHint: record.keyHint,
    userId: record.userId,
    apiKeyId: record.apiKeyId,
    principalRole: record.principalRole,
    ownerBypass: record.ownerBypass,
    responseStatus: record.responseStatus,
    state: record.state,
    elapsedMs: record.elapsedMs,
    responseTimeMs: record.responseTimeMs,
    isStreaming: record.isStreaming,
    enforceMode: record.enforceMode,
    hedgedRouting: record.hedgedRouting,
    hedgeCandidateCount: record.hedgeCandidateCount,
    hedgeCancelledCount: record.hedgeCancelledCount,
    hedgeFailedCount: record.hedgeFailedCount,
    retryCount: record.retryCount,
    errorType: record.errorType,
    promptTokens: record.promptTokens,
    promptTokensEstimated: record.promptTokensEstimated,
    completionTokens: record.completionTokens,
    completionTokensEstimated: record.completionTokensEstimated,
    totalTokens: record.totalTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheCreationTokens: record.cacheCreationTokens,
    cachedTokens: record.cachedTokens,
    matchedTokens: record.matchedTokens ?? 0,
    isCacheHit: record.isCacheHit ?? false,
    msSinceLastMatch: record.msSinceLastMatch,
    userCostUsd: record.userCostUsd ?? 0,
    typicalCostUsd: record.typicalCostUsd ?? 0,
    savedCostUsd: record.savedCostUsd ?? 0,
    streamChunkCount: record.streamChunkCount,
    streamBytes: record.streamBytes,
    payloadStored: undefined,
  };
}

function readAllMetricRows(): RequestMetricRow[] {
  const dir = getStorageDir("metrics");
  if (cachedStorageDir !== dir) {
    metricsFileCache.clear();
    cachedStorageDir = dir;
    allRowsCache = undefined;
    allRowsFingerprint = undefined;
  }
  if (!existsSync(dir)) return [];
  const fingerprint = metricsStoreFingerprint();
  if (allRowsCache !== undefined && allRowsFingerprint === fingerprint) {
    return allRowsCache;
  }
  const rows: RequestMetricRow[] = [];
  const seen = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    seen.add(path);
    const fileRows = readCachedMetricFile(path);
    for (const row of fileRows) rows.push(row);
  }
  for (const path of metricsFileCache.keys()) {
    if (!seen.has(path)) metricsFileCache.delete(path);
  }
  allRowsCache = rows;
  allRowsFingerprint = metricsStoreFingerprint();
  return rows;
}

function readFileRange(path: string, start: number, end: number): string {
  const length = Math.max(0, end - start);
  if (length === 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function parseMetricLines(text: string, rows: RequestMetricRow[]): void {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      rows.push(JSON.parse(line) as RequestMetricRow);
    } catch {
      // Ignore malformed metric rows so a partial write does not break analytics.
    }
  }
}

function readCachedMetricFile(path: string): RequestMetricRow[] {
  let stat: { mtimeMs: number; size: number };
  try {
    stat = statSync(path);
  } catch {
    metricsFileCache.delete(path);
    return [];
  }
  const cached = metricsFileCache.get(path);
  if (cached !== undefined && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.rows;
  }
  if (cached !== undefined && cached.size > 0 && cached.size < stat.size) {
    parseMetricLines(readFileRange(path, cached.size, stat.size), cached.rows);
    cached.mtimeMs = stat.mtimeMs;
    cached.size = stat.size;
    return cached.rows;
  }
  const rows: RequestMetricRow[] = [];
  parseMetricLines(readFileSync(path, "utf8"), rows);
  metricsFileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  return rows;
}

function compareNewestFirst(a: RequestMetricRow, b: RequestMetricRow): number {
  const timestampDelta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
  if (timestampDelta !== 0) return timestampDelta;
  const completedDelta = Date.parse(b.completedAt ?? b.timestamp) - Date.parse(a.completedAt ?? a.timestamp);
  if (completedDelta !== 0) return completedDelta;
  return b.requestId.localeCompare(a.requestId);
}

function matchesFilters(row: RequestMetricRow, filters: RequestLogFilters): boolean {
  if (filters.provider !== undefined && row.resolvedProvider !== filters.provider) return false;
  if (filters.model !== undefined && row.resolvedModel !== filters.model && row.requestedModel !== filters.model) return false;
  if (filters.apiKeyEnvVar !== undefined && row.apiKeyEnvVar !== filters.apiKeyEnvVar) return false;
  if (filters.userId !== undefined && row.userId !== filters.userId) return false;
  if (filters.apiKeyId !== undefined && row.apiKeyId !== filters.apiKeyId) return false;
  if (filters.state !== undefined && row.state !== filters.state) return false;
  if (filters.cacheHit !== undefined && row.isCacheHit !== filters.cacheHit) return false;
  if (filters.status === "ok" && (row.responseStatus === undefined || row.responseStatus >= 400)) return false;
  if (filters.status === "error" && (row.responseStatus !== undefined && row.responseStatus < 400)) return false;
  if (filters.status === "running" && row.state !== "running") return false;
  if (filters.since !== undefined && Date.parse(row.timestamp) < Date.parse(filters.since)) return false;
  if (filters.until !== undefined && Date.parse(row.timestamp) > Date.parse(filters.until)) return false;
  if (filters.search !== undefined && filters.search.trim() !== "") {
    const haystack = [
      row.requestId,
      row.requestedModel,
      row.resolvedProvider,
      row.resolvedModel,
      row.apiKeyEnvVar,
      row.errorType,
      row.userId,
      row.apiKeyId,
    ].join(" ").toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}
