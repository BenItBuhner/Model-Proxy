export interface UsageSnapshot {
  promptTokens: number | undefined;
  promptTokensEstimated: boolean;
  completionTokens: number | undefined;
  completionTokensEstimated: boolean;
  totalTokens: number | undefined;
  cacheReadTokens: number | undefined;
  cacheCreationTokens: number | undefined;
  cachedTokens: number | undefined;
}

export function emptyUsageSnapshot(): UsageSnapshot {
  return {
    promptTokens: undefined,
    promptTokensEstimated: false,
    completionTokens: undefined,
    completionTokensEstimated: false,
    totalTokens: undefined,
    cacheReadTokens: undefined,
    cacheCreationTokens: undefined,
    cachedTokens: undefined,
  };
}

export function normalizeUsageFromResponse(
  protocol: "openai" | "anthropic" | "audio" | "responses" | undefined,
  response: unknown,
): UsageSnapshot {
  if (typeof response !== "object" || response === null) return emptyUsageSnapshot();
  const obj = response as Record<string, unknown>;
  const usage = obj["usage"];
  if (typeof usage !== "object" || usage === null) return emptyUsageSnapshot();
  return normalizeUsageObject(protocol, usage as Record<string, unknown>);
}

export function normalizeUsageObject(
  protocol: "openai" | "anthropic" | "audio" | "responses" | undefined,
  usage: Record<string, unknown>,
): UsageSnapshot {
  const out = emptyUsageSnapshot();
  if (protocol === "anthropic") {
    // Anthropic reports uncached input separately from cache reads/writes;
    // promptTokens is normalized to the full prompt (OpenAI semantics) so
    // totals and cost math stay comparable across providers.
    const inputTokens = numberField(usage, "input_tokens");
    out.cacheReadTokens = numberField(usage, "cache_read_input_tokens");
    out.cacheCreationTokens = numberField(usage, "cache_creation_input_tokens");
    out.cachedTokens = out.cacheReadTokens;
    out.promptTokens =
      inputTokens === undefined
        ? undefined
        : inputTokens + (out.cacheReadTokens ?? 0) + (out.cacheCreationTokens ?? 0);
    out.completionTokens = numberField(usage, "output_tokens");
  } else if (protocol === "responses") {
    out.promptTokens = numberField(usage, "input_tokens");
    out.completionTokens = numberField(usage, "output_tokens");
    out.totalTokens = numberField(usage, "total_tokens");
    const inputDetails = usage["input_tokens_details"];
    if (typeof inputDetails === "object" && inputDetails !== null) {
      out.cachedTokens = numberField(inputDetails as Record<string, unknown>, "cached_tokens");
      out.cacheReadTokens = out.cachedTokens;
    }
  } else {
    out.promptTokens = numberField(usage, "prompt_tokens");
    out.completionTokens = numberField(usage, "completion_tokens");
    out.totalTokens = numberField(usage, "total_tokens");
    const details = usage["prompt_tokens_details"];
    if (typeof details === "object" && details !== null) {
      out.cachedTokens = numberField(details as Record<string, unknown>, "cached_tokens");
      out.cacheReadTokens = out.cachedTokens;
    }
  }
  if (out.totalTokens === undefined) {
    const prompt = out.promptTokens ?? 0;
    const completion = out.completionTokens ?? 0;
    if (prompt > 0 || completion > 0) out.totalTokens = prompt + completion;
  }
  return out;
}

export function mergeUsage(
  base: UsageSnapshot,
  override: Partial<UsageSnapshot>,
): UsageSnapshot {
  const defined = Object.fromEntries(
    Object.entries(override).filter(([, value]) => value !== undefined),
  ) as Partial<UsageSnapshot>;
  const out: UsageSnapshot = { ...base, ...defined };
  if (out.totalTokens === undefined) {
    const prompt = out.promptTokens ?? 0;
    const completion = out.completionTokens ?? 0;
    if (prompt > 0 || completion > 0) out.totalTokens = prompt + completion;
  }
  return out;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
