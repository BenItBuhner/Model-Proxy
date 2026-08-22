import type { UsageSnapshot } from "./usage.ts";

export type StreamProtocol = "openai" | "anthropic";

export interface StreamUsageResult {
  usage: Partial<UsageSnapshot> | undefined;
  completionTokens: number | undefined;
  completionTokensEstimated: boolean;
  capturedText: string | undefined;
}

export class StreamUsageTracker {
  private bufferedLine = "";
  private capturedText = "";
  private responseChars = 0;
  private lastUsage: Partial<UsageSnapshot> | undefined;

  constructor(
    private readonly protocol: StreamProtocol,
    private readonly options: { captureText: boolean; maxCapturedChars: number },
  ) {}

  ingest(chunk: string): void {
    this.responseChars += chunk.length;
    if (this.options.captureText) {
      this.capturedText = appendCaptured(this.capturedText, chunk, this.options.maxCapturedChars);
    }

    this.bufferedLine += chunk;
    const lines = this.bufferedLine.split(/\r?\n/);
    this.bufferedLine = lines.pop() ?? "";
    for (const line of lines) this.ingestLine(line);
  }

  finish(): StreamUsageResult {
    if (this.bufferedLine.trim().length > 0) {
      this.ingestLine(this.bufferedLine);
      this.bufferedLine = "";
    }
    const completionTokens = this.lastUsage?.completionTokens ?? estimateFromChars(this.responseChars);
    return {
      usage: this.lastUsage,
      completionTokens,
      completionTokensEstimated: this.lastUsage?.completionTokens === undefined,
      capturedText: this.options.captureText ? this.capturedText : undefined,
    };
  }

  private ingestLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof parsed !== "object" || parsed === null) return;
    const event = parsed as Record<string, unknown>;
    const usage = event["usage"];
    if (typeof usage !== "object" || usage === null) return;
    const usageObj = usage as Record<string, unknown>;
    this.lastUsage =
      this.protocol === "anthropic"
        ? anthropicUsage(usageObj, this.lastUsage)
        : openAIUsage(usageObj, this.lastUsage);
  }
}

function openAIUsage(
  usage: Record<string, unknown>,
  previous: Partial<UsageSnapshot> | undefined,
): Partial<UsageSnapshot> {
  return {
    promptTokens: numberField(usage, "prompt_tokens") ?? previous?.promptTokens,
    completionTokens: numberField(usage, "completion_tokens") ?? previous?.completionTokens,
    totalTokens: numberField(usage, "total_tokens") ?? previous?.totalTokens,
    cacheReadTokens: previous?.cacheReadTokens,
    cacheCreationTokens: previous?.cacheCreationTokens,
    cachedTokens: previous?.cachedTokens,
  };
}

function anthropicUsage(
  usage: Record<string, unknown>,
  previous: Partial<UsageSnapshot> | undefined,
): Partial<UsageSnapshot> {
  const promptTokens = numberField(usage, "input_tokens") ?? previous?.promptTokens;
  const completionTokens = numberField(usage, "output_tokens") ?? previous?.completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens:
      promptTokens !== undefined && completionTokens !== undefined
        ? promptTokens + completionTokens
        : previous?.totalTokens,
    cacheReadTokens: numberField(usage, "cache_read_input_tokens") ?? previous?.cacheReadTokens,
    cacheCreationTokens: numberField(usage, "cache_creation_input_tokens") ?? previous?.cacheCreationTokens,
    cachedTokens: numberField(usage, "cache_read_input_tokens") ?? previous?.cachedTokens,
  };
}

function appendCaptured(existing: string, chunk: string, maxChars: number): string {
  const combined = existing + chunk;
  if (combined.length <= maxChars) return combined;
  return combined.slice(-maxChars);
}

function estimateFromChars(chars: number): number | undefined {
  return Number.isFinite(chars) && chars > 0 ? Math.ceil(chars / 4) : undefined;
}

function numberField(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
