import { matchesLogFilters } from "../shared/log-filters.ts";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { getStorageDir } from "./storage-paths.ts";
import type { RequestLogRecord } from "../observability/ring-buffer.ts";
import type { RequestLogFilters, RequestMetricRow } from "./types.ts";

export function writeRequestMetric(record: RequestLogRecord): RequestMetricRow {
  const row = metricRowFromRecord(record);
  const completed = row.completedAt ?? row.timestamp;
  const date = new Date(completed);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dir = getStorageDir("metrics");
  appendFileSync(join(dir, `requests-${year}-${month}-${day}.jsonl`), `${JSON.stringify(row)}\n`, "utf8");
  return row;
}

export function listRequestMetricRows({
  limit,
  offset = 0,
  filters = {},
}: {
  limit?: number;
  offset?: number;
  filters?: RequestLogFilters;
}): { records: RequestMetricRow[]; total: number } {
  const rows = readAllMetricRows()
    .filter((row) => matchesLogFilters(row, filters))
    .sort(compareNewestFirst);
  return {
    records: limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit),
    total: rows.length,
  };
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

interface CachedMetricFile {
  mtimeMs: number;
  size: number;
  rows: RequestMetricRow[];
}

const metricFileCache = new Map<string, CachedMetricFile>();

function readMetricFile(dir: string, file: string): RequestMetricRow[] {
  const path = join(dir, file);
  let stat: { mtimeMs: number; size: number };
  try {
    const info = statSync(path);
    stat = { mtimeMs: info.mtimeMs, size: info.size };
  } catch {
    metricFileCache.delete(path);
    return [];
  }
  const cached = metricFileCache.get(path);
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.rows;
  }
  const rows: RequestMetricRow[] = [];
  try {
    const text = readFileSync(path, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line) as RequestMetricRow);
      } catch {
        // Ignore malformed metric rows so a partial write does not break analytics.
      }
    }
  } catch {
    return cached?.rows ?? [];
  }
  metricFileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, rows });
  if (metricFileCache.size > 64) {
    for (const key of metricFileCache.keys()) {
      metricFileCache.delete(key);
      if (metricFileCache.size <= 48) break;
    }
  }
  return rows;
}

function readAllMetricRows(): RequestMetricRow[] {
  const dir = getStorageDir("metrics");
  if (!existsSync(dir)) return [];
  const rows: RequestMetricRow[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    rows.push(...readMetricFile(dir, file));
  }
  return rows;
}

function compareNewestFirst(a: RequestMetricRow, b: RequestMetricRow): number {
  const timestampDelta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
  if (timestampDelta !== 0) return timestampDelta;
  const completedDelta = Date.parse(b.completedAt ?? b.timestamp) - Date.parse(a.completedAt ?? a.timestamp);
  if (completedDelta !== 0) return completedDelta;
  return b.requestId.localeCompare(a.requestId);
}

