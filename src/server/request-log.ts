import { requestLogRingBuffer, type RequestLogRecord } from "../observability/ring-buffer.ts";
import { recordCacheMatch } from "../observability/cache-matcher.ts";
import { createLogger } from "../observability/logger.ts";
import { calculateCosts, resolvePricing } from "../observability/pricing.ts";
import {
  mergeUsage,
  normalizeUsageFromResponse,
  type UsageSnapshot,
} from "../observability/usage.ts";
import { writeCompletionEnvelope } from "../storage/completion-store.ts";
import type { CompletionEnvelope } from "../storage/types.ts";

export interface StartEntry {
  requestId: string;
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  wireProtocol?: "openai" | "anthropic" | "audio";
  isStreaming: boolean;
  enforceMode: boolean;
  hedgedRouting?: boolean;
  promptTokens?: number;
  promptTokensEstimated?: boolean;
  requestBody?: unknown;
  persistCompletions?: boolean;
}

export interface FinishEntry {
  requestId: string;
  responseStatus: number;
  responseTimeMs: number;
  retryCount?: number;
  errorMessage?: string;
  errorType?: string;
  promptTokens?: number;
  promptTokensEstimated?: boolean;
  completionTokens?: number;
  completionTokensEstimated?: boolean;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cachedTokens?: number;
  resolvedProvider?: string;
  resolvedModel?: string;
  apiKeyEnvVar?: string;
  keyHint?: string;
  responseBody?: unknown;
  usage?: Partial<UsageSnapshot>;
}

export interface ProgressEntry {
  requestId: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  apiKeyEnvVar?: string;
  keyHint?: string;
  streamBytes?: number;
  streamChunkCount?: number;
  retryCount?: number;
  hedgedRouting?: boolean;
  hedgeCandidateCount?: number;
  hedgeCancelledCount?: number;
  hedgeFailedCount?: number;
}

type InflightRecord = RequestLogRecord & {
  startedAtEpochMs: number;
  requestBody?: unknown;
  persistCompletions?: boolean;
};

const inflight = new Map<string, InflightRecord>();
const log = createLogger("request-log");
const CLIENT_CLOSED_STATUS = 499;
const STALE_INFLIGHT_MS =
  parseOptionalPositiveInt(process.env.REQUEST_LOG_STALE_RUNNING_MS) ?? 30 * 60 * 1000;

export function recordRequestStart(entry: StartEntry): void {
  inflight.set(entry.requestId, {
    requestId: entry.requestId,
    timestamp: new Date().toISOString(),
    completedAt: undefined,
    endpoint: entry.endpoint,
    method: entry.method,
    requestedModel: entry.requestedModel,
    resolvedProvider: entry.resolvedProvider,
    resolvedModel: entry.resolvedModel,
    apiKeyEnvVar: undefined,
    keyHint: undefined,
    wireProtocol: entry.wireProtocol,
    state: "running",
    responseStatus: undefined,
    responseTimeMs: undefined,
    elapsedMs: 0,
    isStreaming: entry.isStreaming,
    enforceMode: entry.enforceMode,
    hedgedRouting: entry.hedgedRouting,
    hedgeCandidateCount: undefined,
    hedgeCancelledCount: undefined,
    hedgeFailedCount: undefined,
    retryCount: 0,
    errorMessage: undefined,
    errorType: undefined,
    promptTokens: entry.promptTokens,
    promptTokensEstimated: entry.promptTokensEstimated,
    completionTokens: undefined,
    completionTokensEstimated: undefined,
    totalTokens: undefined,
    cacheReadTokens: undefined,
    cacheCreationTokens: undefined,
    cachedTokens: undefined,
    matchedTokens: undefined,
    isCacheHit: undefined,
    msSinceLastMatch: undefined,
    userCostUsd: undefined,
    typicalCostUsd: undefined,
    savedCostUsd: undefined,
    streamChunkCount: undefined,
    streamBytes: undefined,
    startedAtEpochMs: Date.now(),
    requestBody: entry.requestBody,
    persistCompletions: entry.persistCompletions,
  });
}

export function recordRequestProgress(entry: ProgressEntry): void {
  const current = inflight.get(entry.requestId);
  if (current === undefined) return;
  if (entry.resolvedProvider !== undefined) current.resolvedProvider = entry.resolvedProvider;
  if (entry.resolvedModel !== undefined) current.resolvedModel = entry.resolvedModel;
  if (entry.apiKeyEnvVar !== undefined) current.apiKeyEnvVar = entry.apiKeyEnvVar;
  if (entry.keyHint !== undefined) current.keyHint = entry.keyHint;
  if (entry.retryCount !== undefined) current.retryCount = entry.retryCount;
  if (entry.hedgedRouting !== undefined) current.hedgedRouting = entry.hedgedRouting;
  if (entry.hedgeCandidateCount !== undefined) {
    current.hedgeCandidateCount = entry.hedgeCandidateCount;
  }
  if (entry.hedgeCancelledCount !== undefined) {
    current.hedgeCancelledCount = entry.hedgeCancelledCount;
  }
  if (entry.hedgeFailedCount !== undefined) {
    current.hedgeFailedCount = entry.hedgeFailedCount;
  }
  if (entry.streamBytes !== undefined) {
    current.streamBytes = (current.streamBytes ?? 0) + entry.streamBytes;
  }
  if (entry.streamChunkCount !== undefined) {
    current.streamChunkCount = (current.streamChunkCount ?? 0) + entry.streamChunkCount;
  }
}

export function recordRequestFinish(entry: FinishEntry): void {
  const base = inflight.get(entry.requestId);
  if (base === undefined) return;
  inflight.delete(entry.requestId);
  const completedAt = new Date().toISOString();
  const resolvedProvider = entry.resolvedProvider ?? base.resolvedProvider;
  const resolvedModel = entry.resolvedModel ?? base.resolvedModel;
  const apiKeyEnvVar = entry.apiKeyEnvVar ?? base.apiKeyEnvVar;
  const keyHint = entry.keyHint ?? base.keyHint;
  const usage = buildUsageSnapshot(base, entry);
  const cache = recordCacheMatch({
    requestBody: base.requestBody,
    completedAt,
    provider: resolvedProvider,
    model: resolvedModel,
    apiKeyEnvVar,
    promptTokens: usage.promptTokens,
    cacheReadTokens: usage.cacheReadTokens,
  });
  const usageForAnalytics = usage.cacheReadTokens === undefined && cache.matchedTokens > 0
    ? mergeUsage(usage, {
        cacheReadTokens: cache.matchedTokens,
        cachedTokens: cache.matchedTokens,
      })
    : usage;
  const costs = calculateCosts(
    usageForAnalytics,
    resolvePricing({
      requestedModel: base.requestedModel,
      resolvedProvider,
      resolvedModel,
      apiKeyEnvVar,
    }),
  );

  const record: RequestLogRecord = {
    requestId: entry.requestId,
    timestamp: base?.timestamp ?? completedAt,
    completedAt,
    endpoint: base?.endpoint ?? "",
    method: base?.method ?? "POST",
    requestedModel: base?.requestedModel ?? "",
    resolvedProvider,
    resolvedModel,
    apiKeyEnvVar,
    keyHint,
    wireProtocol: base?.wireProtocol,
    state: "completed",
    responseStatus: entry.responseStatus,
    responseTimeMs: entry.responseTimeMs,
    elapsedMs: entry.responseTimeMs,
    isStreaming: base?.isStreaming ?? false,
    enforceMode: base?.enforceMode ?? false,
    hedgedRouting: base?.hedgedRouting,
    hedgeCandidateCount: base?.hedgeCandidateCount,
    hedgeCancelledCount: base?.hedgeCancelledCount,
    hedgeFailedCount: base?.hedgeFailedCount,
    retryCount: entry.retryCount ?? base?.retryCount ?? 0,
    errorMessage: entry.errorMessage,
    errorType: entry.errorType,
    promptTokens: usageForAnalytics.promptTokens,
    promptTokensEstimated: usageForAnalytics.promptTokensEstimated,
    completionTokens: usageForAnalytics.completionTokens,
    completionTokensEstimated: usageForAnalytics.completionTokensEstimated,
    totalTokens: usageForAnalytics.totalTokens,
    cacheReadTokens: usageForAnalytics.cacheReadTokens,
    cacheCreationTokens: usageForAnalytics.cacheCreationTokens,
    cachedTokens: usageForAnalytics.cachedTokens,
    matchedTokens: cache.matchedTokens,
    isCacheHit: cache.isCacheHit,
    msSinceLastMatch: cache.msSinceLastMatch,
    userCostUsd: costs.userCostUsd,
    typicalCostUsd: costs.typicalCostUsd,
    savedCostUsd: costs.savedCostUsd,
    streamChunkCount: base?.streamChunkCount,
    streamBytes: base?.streamBytes,
  };

  requestLogRingBuffer.record(record);
  if ((base.persistCompletions ?? completionPersistenceDefault()) === true) {
    persistCompletion(record, base, entry, usageForAnalytics, costs, cache);
  }
}

export function recordRequestAbort(entry: {
  requestId: string;
  responseTimeMs: number;
  errorMessage?: string;
}): void {
  recordRequestFinish({
    requestId: entry.requestId,
    responseStatus: CLIENT_CLOSED_STATUS,
    responseTimeMs: entry.responseTimeMs,
    errorMessage: entry.errorMessage ?? "Client closed request before completion",
    errorType: "ClientAbort",
  });
}

export function recentRequestLogs(limit = 100, offset = 0): RequestLogRecord[] {
  pruneStaleInflight();
  const now = Date.now();
  const active = Array.from(inflight.values()).map((record) => ({
    ...record,
    elapsedMs: Math.max(0, now - record.startedAtEpochMs),
  }));
  return [...active, ...requestLogRingBuffer.recent()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(offset, offset + limit);
}

export function activeRequestCount(): number {
  pruneStaleInflight();
  return inflight.size;
}

export function requestLogCount(): number {
  pruneStaleInflight();
  return inflight.size + requestLogRingBuffer.size;
}

export function estimateRequestTokens(input: unknown): number | undefined {
  const charCount = countChars(input, new Set());
  if (charCount === 0) return undefined;
  // A cheap, content-free approximation. It stores only the count, never text.
  return Math.max(1, Math.ceil(charCount / 4));
}

export function resetRequestLogForTests(): void {
  inflight.clear();
  requestLogRingBuffer.clear();
}

function buildUsageSnapshot(base: InflightRecord, entry: FinishEntry): UsageSnapshot {
  const fromResponse = normalizeUsageFromResponse(base.wireProtocol, entry.responseBody);
  const explicitUsage: Partial<UsageSnapshot> = {
    promptTokens: entry.promptTokens ?? base.promptTokens,
    promptTokensEstimated:
      entry.promptTokensEstimated ??
      (entry.promptTokens === undefined ? base.promptTokensEstimated === true : false),
    completionTokens: entry.completionTokens,
    completionTokensEstimated: entry.completionTokensEstimated ?? false,
    totalTokens: entry.totalTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheCreationTokens: entry.cacheCreationTokens,
    cachedTokens: entry.cachedTokens,
  };
  return mergeUsage(mergeUsage(fromResponse, explicitUsage), entry.usage ?? {});
}

function persistCompletion(
  record: RequestLogRecord,
  base: InflightRecord,
  entry: FinishEntry,
  usage: UsageSnapshot,
  costs: { userCostUsd: number; typicalCostUsd: number; savedCostUsd: number },
  cache: {
    cacheScope: string | undefined;
    promptFingerprint: string | undefined;
    matchedTokens: number;
    isCacheHit: boolean;
    msSinceLastMatch: number | undefined;
  },
): void {
  const envelope: CompletionEnvelope = {
    version: 1,
    requestId: record.requestId,
    storedAt: new Date().toISOString(),
    request: {
      timestamp: record.timestamp,
      completedAt: record.completedAt,
      endpoint: record.endpoint,
      method: record.method,
      body: base.requestBody,
    },
    route: {
      requestedModel: record.requestedModel,
      resolvedProvider: record.resolvedProvider,
      resolvedModel: record.resolvedModel,
      wireProtocol: record.wireProtocol,
      apiKeyEnvVar: record.apiKeyEnvVar,
      keyHint: record.keyHint,
    },
    response: {
      status: record.responseStatus,
      body: entry.responseBody,
      errorMessage: record.errorMessage,
      errorType: record.errorType,
      elapsedMs: record.elapsedMs,
      isStreaming: record.isStreaming,
      streamBytes: record.streamBytes,
      streamChunkCount: record.streamChunkCount,
    },
    usage,
    cost: costs,
    cache,
    logRecord: record,
  };
  try {
    writeCompletionEnvelope(envelope);
  } catch (err) {
    log.warn("failed to persist completion envelope", {
      requestId: record.requestId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function countChars(value: unknown, seen: Set<object>): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value).length;
  }
  if (typeof value !== "object" || value === undefined) return 0;
  if (seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countChars(item, seen) + 4, 0);
  }
  let total = 0;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    total += key.length + countChars(nested, seen) + 2;
  }
  return total;
}

function pruneStaleInflight(): void {
  const now = Date.now();
  for (const record of Array.from(inflight.values())) {
    const elapsedMs = now - record.startedAtEpochMs;
    if (elapsedMs < STALE_INFLIGHT_MS) continue;
    recordRequestFinish({
      requestId: record.requestId,
      responseStatus: CLIENT_CLOSED_STATUS,
      responseTimeMs: elapsedMs,
      errorMessage: `Request was still marked running after ${STALE_INFLIGHT_MS}ms and was closed as stale`,
      errorType: "StaleInflightRequest",
    });
  }
}

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function completionPersistenceDefault(): boolean {
  return /^(1|true|yes|on)$/i.test(process.env.PERSIST_COMPLETIONS?.trim() ?? "");
}
