import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { getStorageDir, getStorageRoot } from "../storage/storage-paths.ts";

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
const FLUSH_DEBOUNCE_MS = 2000;
const FLUSH_MAX_PENDING = 100;
/** Cap on retained entries, enforced in memory as well as on disk so the
 * module-level cache cannot grow unboundedly in a long-lived process. */
const MAX_CACHE_ENTRIES = 5000;

let cache: CacheEntry[] | undefined;
let cacheRoot: string | undefined;
let dirty = false;
let dirtySince = 0;
let pendingCount = 0;

function loadEntries(): CacheEntry[] {
  const root = getStorageRoot();
  if (cache === undefined || cacheRoot !== root) {
    cacheRoot = root;
    const path = cachePath();
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        cache = Array.isArray(parsed) ? parsed as CacheEntry[] : [];
      } catch {
        cache = [];
      }
    } else {
      cache = [];
    }
  }
  return cache;
}

/** Flush pending changes if the batch is old or large enough. Called on each
 * record instead of from a timer so writes never race storage teardown. */
function maybeFlush(): void {
  if (!dirty) return;
  if (Date.now() - dirtySince < FLUSH_DEBOUNCE_MS && pendingCount < FLUSH_MAX_PENDING) return;
  flushNow();
}

function flushNow(): void {
  if (!dirty || cache === undefined) return;
  if (cacheRoot !== getStorageRoot()) {
    dirty = false;
    pendingCount = 0;
    return;
  }
  const path = cachePath();
  if (!existsSync(dirname(path))) {
    dirty = false;
    pendingCount = 0;
    cache = undefined;
    return;
  }
  try {
    writeFileSync(path, JSON.stringify(cache.slice(-MAX_CACHE_ENTRIES), null, 2) + "\n", "utf8");
    dirty = false;
    pendingCount = 0;
  } catch {
    // Retain in memory; the next successful flush persists everything.
  }
}

/** Force-persist pending cache-match state. Used by tests and graceful drains. */
export function flushCacheMatchesForTests(): void {
  flushNow();
}

// flushNow is fully synchronous (writeFileSync), so debounced entries survive
// a graceful process exit instead of losing up to FLUSH_DEBOUNCE_MS of state.
process.on("exit", flushNow);

export function recordCacheMatch(input: CacheMatchInput): CacheMatchResult {
  const cacheScope = buildScope(input);
  const promptFingerprint = fingerprintPrompt(input.requestBody);
  if (cacheScope === undefined || promptFingerprint === undefined) {
    return emptyResult(cacheScope, promptFingerprint);
  }

  const entries = loadEntries();
  const nowMs = Date.parse(input.completedAt);
  const previous = entries.find(
    (entry) => entry.scope === cacheScope && entry.fingerprint === promptFingerprint,
  );
  const msSinceLastMatch =
    previous !== undefined ? Math.max(0, nowMs - Date.parse(previous.completedAt)) : undefined;
  const withinWindow =
    msSinceLastMatch !== undefined && msSinceLastMatch <= cacheWindowMs();
  const promptTokens = input.promptTokens ?? 0;
  const matchedTokens =
    input.cacheReadTokens !== undefined
      ? input.cacheReadTokens
      : withinWindow
        ? promptTokens
        : 0;

  upsertEntry(entries, {
    scope: cacheScope,
    fingerprint: promptFingerprint,
    completedAt: input.completedAt,
    promptTokens: input.promptTokens,
  });
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries.splice(0, entries.length - MAX_CACHE_ENTRIES);
  }
  if (!dirty) {
    dirty = true;
    dirtySince = Date.now();
  }
  pendingCount += 1;
  maybeFlush();

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

function upsertEntry(entries: CacheEntry[], entry: CacheEntry): void {
  const idx = entries.findIndex(
    (candidate) => candidate.scope === entry.scope && candidate.fingerprint === entry.fingerprint,
  );
  if (idx >= 0) entries.splice(idx, 1);
  entries.push(entry);
}
