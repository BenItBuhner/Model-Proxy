/** Build a usage snapshot from raw token counts, flagged as estimated. */
export function usageSnapshotFromCounts(counts: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptTokensEstimated: boolean;
  completionTokensEstimated: boolean;
  cacheReadTokens: undefined;
  cacheCreationTokens: undefined;
  cachedTokens: undefined;
} {
  return {
    ...counts,
    promptTokensEstimated: true,
    completionTokensEstimated: true,
    cacheReadTokens: undefined,
    cacheCreationTokens: undefined,
    cachedTokens: undefined,
  };
}
