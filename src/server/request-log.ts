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

let requestsStarted = 0;
let requestsFinished = 0;
let responsesOk = 0;
let responsesError = 0;

export interface RequestLifetimeStats {
  requests_started: number;
  requests_finished: number;
  responses_ok: number;
  responses_error: number;
  inflight: number;
}

export function routeFinishFields(
  resolvedRoute: { provider?: string; model?: string },
): Pick<FinishEntry, "resolvedProvider" | "resolvedModel"> {
  const fields: Pick<FinishEntry, "resolvedProvider" | "resolvedModel"> = {};
  if (resolvedRoute.provider !== undefined) {
    fields.resolvedProvider = resolvedRoute.provider;
  }
  if (resolvedRoute.model !== undefined) {
    fields.resolvedModel = resolvedRoute.model;
  }
  return fields;
}

export function getRequestLifetimeStats(): RequestLifetimeStats {
  return {
    requests_started: requestsStarted,
    requests_finished: requestsFinished,
    responses_ok: responsesOk,
    responses_error: responsesError,
    inflight: inflight.size,
  };
}

export function recordRequestStart(entry: StartEntry): void {
  requestsStarted += 1;
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
  requestsFinished += 1;
  if (entry.responseStatus < 400) responsesOk += 1;
  else responsesError += 1;

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
