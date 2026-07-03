import type { RequestLogRecord } from "../observability/ring-buffer.ts";
import type { UsageSnapshot } from "../observability/usage.ts";

export interface CostSnapshot {
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
}

export interface CacheSnapshot {
  cacheScope: string | undefined;
  promptFingerprint: string | undefined;
  matchedTokens: number;
  isCacheHit: boolean;
  msSinceLastMatch: number | undefined;
}

export interface CompletionEnvelope {
  version: 1;
  requestId: string;
  storedAt: string;
  request: {
    timestamp: string;
    completedAt: string | undefined;
    endpoint: string;
    method: string;
    body: unknown;
  };
  route: {
    requestedModel: string;
    resolvedProvider: string | undefined;
    resolvedModel: string | undefined;
    wireProtocol: "openai" | "anthropic" | "audio" | undefined;
    apiKeyEnvVar: string | undefined;
    keyHint: string | undefined;
  };
  response: {
    status: number | undefined;
    body: unknown;
    errorMessage: string | undefined;
    errorType: string | undefined;
    elapsedMs: number;
    isStreaming: boolean;
    streamBytes: number | undefined;
    streamChunkCount: number | undefined;
  };
  usage: UsageSnapshot;
  cost: CostSnapshot;
  cache: CacheSnapshot;
  logRecord: RequestLogRecord;
}

export interface RequestIndexRow {
  requestId: string;
  path: string;
  timestamp: string;
  completedAt: string | undefined;
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedProvider: string | undefined;
  resolvedModel: string | undefined;
  wireProtocol: "openai" | "anthropic" | "audio" | undefined;
  apiKeyEnvVar: string | undefined;
  keyHint: string | undefined;
  responseStatus: number | undefined;
  state: "running" | "completed";
  elapsedMs: number;
  responseTimeMs: number | undefined;
  isStreaming: boolean;
  enforceMode: boolean;
  retryCount: number;
  errorType: string | undefined;
  promptTokens: number | undefined;
  promptTokensEstimated: boolean | undefined;
  completionTokens: number | undefined;
  completionTokensEstimated: boolean | undefined;
  totalTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  matchedTokens: number;
  isCacheHit: boolean;
  msSinceLastMatch: number | undefined;
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
}

export interface RequestMetricRow {
  version: 1;
  requestId: string;
  timestamp: string;
  completedAt: string | undefined;
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedProvider: string | undefined;
  resolvedModel: string | undefined;
  wireProtocol: "openai" | "anthropic" | "audio" | undefined;
  apiKeyEnvVar: string | undefined;
  keyHint: string | undefined;
  userId: string | undefined;
  apiKeyId: string | undefined;
  principalRole: string | undefined;
  ownerBypass: boolean | undefined;
  responseStatus: number | undefined;
  state: "running" | "completed";
  elapsedMs: number;
  responseTimeMs: number | undefined;
  isStreaming: boolean;
  enforceMode: boolean;
  hedgedRouting: boolean | undefined;
  hedgeCandidateCount: number | undefined;
  hedgeCancelledCount: number | undefined;
  hedgeFailedCount: number | undefined;
  retryCount: number;
  errorType: string | undefined;
  promptTokens: number | undefined;
  promptTokensEstimated: boolean | undefined;
  completionTokens: number | undefined;
  completionTokensEstimated: boolean | undefined;
  totalTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  cachedTokens: number | undefined;
  matchedTokens: number;
  isCacheHit: boolean;
  msSinceLastMatch: number | undefined;
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
  streamChunkCount: number | undefined;
  streamBytes: number | undefined;
  payloadStored: boolean | undefined;
}

export interface RequestLogFilters {
  provider?: string;
  model?: string;
  apiKeyEnvVar?: string;
  userId?: string;
  apiKeyId?: string;
  status?: "ok" | "error" | "running";
  state?: "running" | "completed";
  cacheHit?: boolean;
  since?: string;
  until?: string;
  search?: string;
}

export interface AnalyticsSummary {
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  activeRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  matchedTokens: number;
  cacheHits: number;
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
  avgLatencyMs: number | undefined;
  p95LatencyMs: number | undefined;
  avgTokensPerSecond: number | undefined;
  byProviderKey: Array<{
    provider: string;
    apiKeyEnvVar: string;
    model: string;
    requests: number;
    totalTokens: number;
    userCostUsd: number;
    typicalCostUsd: number;
    savedCostUsd: number;
    cacheHits: number;
  }>;
}
