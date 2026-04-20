import { requestLogRingBuffer, type RequestLogRecord } from "../observability/ring-buffer.ts";

export interface StartEntry {
  requestId: string;
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedModel?: string;
  resolvedProvider?: string;
  wireProtocol?: "openai" | "anthropic";
  isStreaming: boolean;
  enforceMode: boolean;
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

const inflight = new Map<string, Partial<RequestLogRecord>>();

export function recordRequestStart(entry: StartEntry): void {
  inflight.set(entry.requestId, {
    requestId: entry.requestId,
    timestamp: new Date().toISOString(),
    endpoint: entry.endpoint,
    method: entry.method,
    requestedModel: entry.requestedModel,
    resolvedProvider: entry.resolvedProvider,
    resolvedModel: entry.resolvedModel,
    wireProtocol: entry.wireProtocol,
    isStreaming: entry.isStreaming,
    enforceMode: entry.enforceMode,
    retryCount: 0,
  });
}

export function recordRequestFinish(entry: FinishEntry): void {
  const base = inflight.get(entry.requestId);
  inflight.delete(entry.requestId);

  const record: RequestLogRecord = {
    requestId: entry.requestId,
    timestamp: base?.timestamp ?? new Date().toISOString(),
    endpoint: base?.endpoint ?? "",
    method: base?.method ?? "POST",
    requestedModel: base?.requestedModel ?? "",
    resolvedProvider: entry.resolvedProvider ?? base?.resolvedProvider,
    resolvedModel: entry.resolvedModel ?? base?.resolvedModel,
    wireProtocol: base?.wireProtocol,
    responseStatus: entry.responseStatus,
    responseTimeMs: entry.responseTimeMs,
    isStreaming: base?.isStreaming ?? false,
    enforceMode: base?.enforceMode ?? false,
    retryCount: entry.retryCount ?? base?.retryCount ?? 0,
    errorMessage: entry.errorMessage,
    errorType: entry.errorType,
    promptTokens: entry.promptTokens,
    completionTokens: entry.completionTokens,
    totalTokens: entry.totalTokens,
  };

  requestLogRingBuffer.record(record);
}
