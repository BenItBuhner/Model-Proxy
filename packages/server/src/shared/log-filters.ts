import type { RequestLogFilters } from "../storage/types.ts";

/** Structural subset shared by RequestLogRecord, RequestMetricRow, and
 * RequestIndexRow so one predicate can filter all three. */
export interface FilterableLogRow {
  requestId: string;
  requestedModel: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  apiKeyEnvVar?: string;
  errorType?: string;
  userId?: string;
  apiKeyId?: string;
  state: string;
  responseStatus?: number;
  isCacheHit?: boolean;
  timestamp: string;
}

/** Single filter predicate shared by the admin log endpoint and the storage
 * layers, so every surface applies identical filtering semantics.
 *
 * Identity filters (`userId`, `apiKeyId`) fail closed: rows that do not carry
 * the field are excluded. RequestIndexRow (the completion index) never
 * populates them, so passing an identity filter to that store returns nothing
 * by design — do not wire per-user views to the completion index without
 * adding those fields to the row type first. */
export function matchesLogFilters(row: FilterableLogRow, filters: RequestLogFilters): boolean {
  if (filters.provider !== undefined && row.resolvedProvider !== filters.provider) return false;
  if (filters.model !== undefined && row.resolvedModel !== filters.model && row.requestedModel !== filters.model) return false;
  if (filters.apiKeyEnvVar !== undefined && row.apiKeyEnvVar !== filters.apiKeyEnvVar) return false;
  if (filters.userId !== undefined && row.userId !== filters.userId) return false;
  if (filters.apiKeyId !== undefined && row.apiKeyId !== filters.apiKeyId) return false;
  if (filters.state !== undefined && row.state !== filters.state) return false;
  if (filters.cacheHit !== undefined && row.isCacheHit !== filters.cacheHit) return false;
  if (filters.status === "ok" && (row.responseStatus === undefined || row.responseStatus >= 400)) return false;
  if (filters.status === "error" && (row.responseStatus !== undefined && row.responseStatus < 400)) return false;
  if (filters.status === "running" && row.state !== "running") return false;
  if (filters.since !== undefined && Date.parse(row.timestamp) < Date.parse(filters.since)) return false;
  if (filters.until !== undefined && Date.parse(row.timestamp) > Date.parse(filters.until)) return false;
  if (filters.search !== undefined && filters.search.trim() !== "") {
    const haystack = [
      row.requestId,
      row.requestedModel,
      row.resolvedProvider,
      row.resolvedModel,
      row.apiKeyEnvVar,
      row.errorType,
      row.userId,
      row.apiKeyId,
    ].join(" ").toLowerCase();
    if (!haystack.includes(filters.search.toLowerCase())) return false;
  }
  return true;
}
