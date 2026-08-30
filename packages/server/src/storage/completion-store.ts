import { matchesLogFilters } from "../shared/log-filters.ts";
import { parsePositiveInt } from "../shared/utils.ts";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { getStorageDir, getStorageRoot } from "./storage-paths.ts";
import type { CompletionEnvelope, RequestIndexRow, RequestLogFilters } from "./types.ts";

const REDACTED = "[redacted]";
const SECRET_KEY_PATTERN = /authorization|api[_-]?key|token|secret|password|credential/i;
const MAX_STORED_STRING_CHARS = parsePositiveInt(process.env.STORAGE_MAX_STRING_CHARS) ?? 12_000;
const MAX_STORED_ARRAY_ITEMS = parsePositiveInt(process.env.STORAGE_MAX_ARRAY_ITEMS) ?? 200;
const MAX_STORAGE_DEPTH = parsePositiveInt(process.env.STORAGE_MAX_DEPTH) ?? 40;

export function writeCompletionEnvelope(envelope: CompletionEnvelope): RequestIndexRow {
  const completed = envelope.request.completedAt ?? envelope.storedAt;
  const date = new Date(completed);
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const dir = getStorageDir("completions", year, month, day);
  const filename = `${safeFilename(envelope.requestId)}.json`;
  const absolutePath = join(dir, filename);
  writeFileSync(absolutePath, JSON.stringify(sanitizeStorageValue(envelope), null, 2) + "\n", "utf8");

  const indexRow = indexRowFromEnvelope(envelope, relative(getStorageRoot(), absolutePath));
  const indexDir = getStorageDir("indexes");
  appendFileSync(join(indexDir, `requests-${year}-${month}-${day}.jsonl`), `${JSON.stringify(indexRow)}\n`, "utf8");
  return indexRow;
}

export function readCompletionEnvelope(requestId: string): CompletionEnvelope | undefined {
  for (const row of listRequestIndexRows({ limit: undefined, offset: 0 }).records) {
    if (row.requestId !== requestId) continue;
    const path = join(getStorageRoot(), row.path);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8")) as CompletionEnvelope;
  }
  return undefined;
}

export function listRequestIndexRows({
  limit,
  offset = 0,
  filters = {},
}: {
  limit?: number;
  offset?: number;
  filters?: RequestLogFilters;
}): { records: RequestIndexRow[]; total: number } {
  const rows = readAllIndexRows()
    .filter((row) => matchesLogFilters(row, filters))
    .sort(compareNewestFirst);
  return {
    records: limit === undefined ? rows.slice(offset) : rows.slice(offset, offset + limit),
    total: rows.length,
  };
}

export function sanitizeStorageValue(value: unknown, seen = new Set<object>(), depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return summarizeLongString(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_STORAGE_DEPTH) return "[max-depth]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_STORED_ARRAY_ITEMS)
      .map((item) => sanitizeStorageValue(item, seen, depth + 1));
    if (value.length > MAX_STORED_ARRAY_ITEMS) {
      items.push({
        truncated_items: value.length - MAX_STORED_ARRAY_ITEMS,
        original_length: value.length,
      });
    }
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : sanitizeStorageValue(nested, seen, depth + 1);
  }
  return out;
}

function summarizeLongString(value: string): unknown {
  if (value.length <= MAX_STORED_STRING_CHARS) return value;
  const half = Math.max(1, Math.floor(MAX_STORED_STRING_CHARS / 2));
  return {
    truncated: true,
    original_length: value.length,
    sha256: createHash("sha256").update(value).digest("hex"),
    prefix: value.slice(0, half),
    suffix: value.slice(-half),
  };
}


function readAllIndexRows(): RequestIndexRow[] {
  const dir = getStorageDir("indexes");
  const rows: RequestIndexRow[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const text = readFileSync(join(dir, file), "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      try {
        rows.push(JSON.parse(line) as RequestIndexRow);
      } catch {
        // Ignore malformed rows so one bad write does not brick observability.
      }
    }
  }
  return rows;
}

function compareNewestFirst(a: RequestIndexRow, b: RequestIndexRow): number {
  const timestampDelta = Date.parse(b.timestamp) - Date.parse(a.timestamp);
  if (timestampDelta !== 0) return timestampDelta;
  const completedDelta = Date.parse(b.completedAt ?? b.timestamp) - Date.parse(a.completedAt ?? a.timestamp);
  if (completedDelta !== 0) return completedDelta;
  return b.requestId.localeCompare(a.requestId);
}

function indexRowFromEnvelope(envelope: CompletionEnvelope, path: string): RequestIndexRow {
  const record = envelope.logRecord;
  return {
    requestId: envelope.requestId,
    path,
    timestamp: record.timestamp,
    completedAt: record.completedAt,
    endpoint: record.endpoint,
    method: record.method,
    requestedModel: record.requestedModel,
    resolvedProvider: record.resolvedProvider,
    resolvedModel: record.resolvedModel,
    wireProtocol: record.wireProtocol,
    apiKeyEnvVar: record.apiKeyEnvVar,
    keyHint: record.keyHint,
    responseStatus: record.responseStatus,
    state: record.state,
    elapsedMs: record.elapsedMs,
    responseTimeMs: record.responseTimeMs,
    isStreaming: record.isStreaming,
    enforceMode: record.enforceMode,
    retryCount: record.retryCount,
    errorType: record.errorType,
    promptTokens: record.promptTokens,
    promptTokensEstimated: record.promptTokensEstimated,
    completionTokens: record.completionTokens,
    completionTokensEstimated: record.completionTokensEstimated,
    totalTokens: record.totalTokens,
    cacheReadTokens: record.cacheReadTokens,
    cacheCreationTokens: record.cacheCreationTokens,
    matchedTokens: record.matchedTokens ?? 0,
    isCacheHit: record.isCacheHit ?? false,
    msSinceLastMatch: record.msSinceLastMatch,
    userCostUsd: record.userCostUsd ?? 0,
    typicalCostUsd: record.typicalCostUsd ?? 0,
    savedCostUsd: record.savedCostUsd ?? 0,
  };
}


function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160);
}
