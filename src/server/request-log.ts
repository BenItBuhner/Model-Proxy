import { requestLogRingBuffer, type RequestLogRecord } from "../observability/ring-buffer.ts";

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
  promptTokens?: number;
  promptTokensEstimated?: boolean;
}

export interface FinishEntry {
  requestId: string;
  responseStatus: number;
  responseTimeMs: number;
  retryCount?: number;
  errorMessage?: string;
  errorType?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  resolvedProvider?: string;
  resolvedModel?: string;
}

export interface ProgressEntry {
  requestId: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  streamBytes?: number;
  streamChunkCount?: number;
  retryCount?: number;
}

type InflightRecord = RequestLogRecord & { startedAtEpochMs: number };

const inflight = new Map<string, InflightRecord>();

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
    wireProtocol: entry.wireProtocol,
    state: "running",
    responseStatus: undefined,
    responseTimeMs: undefined,
    elapsedMs: 0,
    isStreaming: entry.isStreaming,
    enforceMode: entry.enforceMode,
    retryCount: 0,
    errorMessage: undefined,
    errorType: undefined,
    promptTokens: entry.promptTokens,
    promptTokensEstimated: entry.promptTokensEstimated,
    completionTokens: undefined,
    totalTokens: undefined,
    streamChunkCount: undefined,
    streamBytes: undefined,
    startedAtEpochMs: Date.now(),
  });
}

export function recordRequestProgress(entry: ProgressEntry): void {
  const current = inflight.get(entry.requestId);
  if (current === undefined) return;
  if (entry.resolvedProvider !== undefined) current.resolvedProvider = entry.resolvedProvider;
  if (entry.resolvedModel !== undefined) current.resolvedModel = entry.resolvedModel;
  if (entry.retryCount !== undefined) current.retryCount = entry.retryCount;
  if (entry.streamBytes !== undefined) {
    current.streamBytes = (current.streamBytes ?? 0) + entry.streamBytes;
  }
  if (entry.streamChunkCount !== undefined) {
    current.streamChunkCount = (current.streamChunkCount ?? 0) + entry.streamChunkCount;
  }
}

export function recordRequestFinish(entry: FinishEntry): void {
  const base = inflight.get(entry.requestId);
  inflight.delete(entry.requestId);
  const completedAt = new Date().toISOString();

  const record: RequestLogRecord = {
    requestId: entry.requestId,
    timestamp: base?.timestamp ?? completedAt,
    completedAt,
    endpoint: base?.endpoint ?? "",
    method: base?.method ?? "POST",
    requestedModel: base?.requestedModel ?? "",
    resolvedProvider: entry.resolvedProvider ?? base?.resolvedProvider,
    resolvedModel: entry.resolvedModel ?? base?.resolvedModel,
    wireProtocol: base?.wireProtocol,
    state: "completed",
    responseStatus: entry.responseStatus,
    responseTimeMs: entry.responseTimeMs,
    elapsedMs: entry.responseTimeMs,
    isStreaming: base?.isStreaming ?? false,
    enforceMode: base?.enforceMode ?? false,
    retryCount: entry.retryCount ?? base?.retryCount ?? 0,
    errorMessage: entry.errorMessage,
    errorType: entry.errorType,
    promptTokens: entry.promptTokens ?? base?.promptTokens,
    promptTokensEstimated: entry.promptTokens === undefined ? base?.promptTokensEstimated : false,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
    streamChunkCount: base?.streamChunkCount,
    streamBytes: base?.streamBytes,
  };

  requestLogRingBuffer.record(record);
}

export function recentRequestLogs(limit = 100): RequestLogRecord[] {
  const now = Date.now();
  const active = Array.from(inflight.values()).map((record) => ({
    ...record,
    elapsedMs: Math.max(0, now - record.startedAtEpochMs),
  }));
  return [...active, ...requestLogRingBuffer.recent()]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

export function activeRequestCount(): number {
  return inflight.size;
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
