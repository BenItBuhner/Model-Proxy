import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getStorageDir } from "../storage/storage-paths.ts";

interface CacheEntry {
  scope: string;
  fingerprint: string;
  completedAt: string;
  promptTokens: number | undefined;
}

export interface CacheMatchInput {
  requestBody: unknown;
  completedAt: string;
  provider?: string;
  model?: string;
  apiKeyEnvVar?: string;
  promptTokens?: number;
  cacheReadTokens?: number;
}

export interface CacheMatchResult {
  cacheScope: string | undefined;
  promptFingerprint: string | undefined;
  matchedTokens: number;
  isCacheHit: boolean;
  msSinceLastMatch: number | undefined;
}

const DEFAULT_CACHE_WINDOW_MS = 5 * 60 * 1000;
const MAX_INLINE_FINGERPRINT_STRING_CHARS =
  parsePositiveInt(process.env.CACHE_FINGERPRINT_INLINE_STRING_CHARS) ?? 4096;

export function recordCacheMatch(input: CacheMatchInput): CacheMatchResult {
  const cacheScope = buildScope(input);
  const promptFingerprint = fingerprintPrompt(input.requestBody);
  if (cacheScope === undefined || promptFingerprint === undefined) {
    return emptyResult(cacheScope, promptFingerprint);
  }

  const entries = readEntries();
  const nowMs = Date.parse(input.completedAt);
  const previous = entries.find(
    (entry) => entry.scope === cacheScope && entry.fingerprint === promptFingerprint,
  );
  const msSinceLastMatch =
    previous !== undefined ? Math.max(0, nowMs - Date.parse(previous.completedAt)) : undefined;
  const withinWindow =
    msSinceLastMatch !== undefined && msSinceLastMatch <= cacheWindowMs();
  const providerMatchedTokens =
    input.cacheReadTokens !== undefined && input.cacheReadTokens > 0 ? input.cacheReadTokens : undefined;
  const promptTokens = input.promptTokens ?? 0;
  const matchedTokens =
    providerMatchedTokens !== undefined || withinWindow
      ? Math.max(promptTokens, providerMatchedTokens ?? 0)
      : 0;

  upsertEntry(entries, {
    scope: cacheScope,
    fingerprint: promptFingerprint,
    completedAt: input.completedAt,
    promptTokens: input.promptTokens,
  });
  writeEntries(entries);

  return {
    cacheScope,
    promptFingerprint,
    matchedTokens,
    isCacheHit: matchedTokens > 0,
    msSinceLastMatch,
  };
}

function emptyResult(cacheScope: string | undefined, promptFingerprint: string | undefined): CacheMatchResult {
  return {
    cacheScope,
    promptFingerprint,
    matchedTokens: 0,
    isCacheHit: false,
    msSinceLastMatch: undefined,
  };
}

function buildScope(input: CacheMatchInput): string | undefined {
  if (input.provider === undefined || input.model === undefined || input.apiKeyEnvVar === undefined) {
    return undefined;
  }
  return `${input.provider}|${input.apiKeyEnvVar}|${input.model}`;
}

function fingerprintPrompt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return createHash("sha256").update(stableStringify(extractPromptShape(value))).digest("hex");
}

function extractPromptShape(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const obj = value as Record<string, unknown>;
  return {
    model: obj["model"],
    messages: obj["messages"],
    system: obj["system"],
    input: obj["input"],
  };
}

function stableStringify(value: unknown): string {
  if (typeof value === "string") {
    if (value.length <= MAX_INLINE_FINGERPRINT_STRING_CHARS) return JSON.stringify(value);
    return JSON.stringify({
      type: "hashed-string",
      length: value.length,
      sha256: createHash("sha256").update(value).digest("hex"),
    });
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
}

function cacheWindowMs(): number {
  const parsed = Number.parseInt(process.env.ANALYTICS_CACHE_HIT_WINDOW_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CACHE_WINDOW_MS;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function cachePath(): string {
  return join(getStorageDir("analytics"), "cache-matches.json");
}

function readEntries(): CacheEntry[] {
  const path = cachePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed as CacheEntry[] : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: CacheEntry[]): void {
  writeFileSync(cachePath(), JSON.stringify(entries.slice(-5000), null, 2) + "\n", "utf8");
}

function upsertEntry(entries: CacheEntry[], entry: CacheEntry): void {
  const idx = entries.findIndex(
    (candidate) => candidate.scope === entry.scope && candidate.fingerprint === entry.fingerprint,
  );
  if (idx >= 0) entries.splice(idx, 1);
  entries.push(entry);
}
