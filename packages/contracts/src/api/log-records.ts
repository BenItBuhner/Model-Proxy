/**
 * In-memory request observability record served by `/v1/admin/logs`.
 * Single source of truth for both the server ring buffer and the web UI.
 */
export interface RequestLogRecord {
  requestId: string;
  timestamp: string;
  completedAt: string | undefined;
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedProvider: string | undefined;
  resolvedModel: string | undefined;
  apiKeyEnvVar: string | undefined;
  keyHint: string | undefined;
  wireProtocol: "openai" | "anthropic" | "audio" | "responses" | undefined;
  userId: string | undefined;
  apiKeyId: string | undefined;
  principalRole: string | undefined;
  ownerBypass: boolean | undefined;
  state: "running" | "completed";
  responseStatus: number | undefined;
  responseTimeMs: number | undefined;
  elapsedMs: number;
  isStreaming: boolean;
  enforceMode: boolean;
  hedgedRouting: boolean | undefined;
  hedgeCandidateCount: number | undefined;
  hedgeCancelledCount: number | undefined;
  hedgeFailedCount: number | undefined;
  retryCount: number;
  errorMessage: string | undefined;
  errorType: string | undefined;
  promptTokens: number | undefined;
  promptTokensEstimated: boolean | undefined;
  completionTokens: number | undefined;
  completionTokensEstimated: boolean | undefined;
  totalTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  cachedTokens: number | undefined;
  matchedTokens: number | undefined;
  isCacheHit: boolean | undefined;
  msSinceLastMatch: number | undefined;
  userCostUsd: number | undefined;
  typicalCostUsd: number | undefined;
  savedCostUsd: number | undefined;
  streamChunkCount: number | undefined;
  streamBytes: number | undefined;
}
