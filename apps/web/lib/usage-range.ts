import type { ObservabilityFilters } from "./endpoints";

export type UsagePreset = "24h" | "7d" | "30d" | "90d" | "all" | "custom";

export type UsageBucket = "hour" | "day";

const COUNTER_STORAGE_PREFIX = "model-proxy.usage-counter-start";

export function counterStorageKey(scope?: string): string {
  return scope !== undefined && scope !== ""
    ? `${COUNTER_STORAGE_PREFIX}.${scope}`
    : COUNTER_STORAGE_PREFIX;
}

export function readCounterStart(scope?: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = window.localStorage.getItem(counterStorageKey(scope));
    if (value === null || value.trim() === "") return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  } catch {
    return undefined;
  }
}

export function writeCounterStart(iso: string | undefined, scope?: string): void {
  if (typeof window === "undefined") return;
  try {
    const key = counterStorageKey(scope);
    if (iso === undefined) {
      window.localStorage.removeItem(key);
      return;
    }
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    window.localStorage.setItem(key, date.toISOString());
  } catch {
    // Ignore storage failures; counter still works for the current session via state.
  }
}

export function presetSince(preset: UsagePreset, now = new Date()): string | undefined {
  switch (preset) {
    case "24h":
      return new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    case "7d":
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    case "30d":
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    case "90d":
      return new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
    case "all":
    case "custom":
      return undefined;
  }
}

export function suggestedBucket(since: string | undefined, until: string | undefined, now = new Date()): UsageBucket {
  if (since === undefined) return "day";
  const start = new Date(since).getTime();
  const end = until !== undefined ? new Date(until).getTime() : now.getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return "day";
  const spanMs = Math.max(0, end - start);
  return spanMs <= 3 * 24 * 60 * 60 * 1000 ? "hour" : "day";
}

export function latestIso(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (Number.isNaN(aTime)) return b;
  if (Number.isNaN(bTime)) return a;
  return aTime >= bTime ? a : b;
}

export function mergeUsageFilters({
  base = {},
  preset,
  customSince,
  customUntil,
  counterStart,
}: {
  base?: ObservabilityFilters;
  preset: UsagePreset;
  customSince?: string;
  customUntil?: string;
  counterStart?: string;
}): ObservabilityFilters {
  const presetBound = preset === "custom" ? customSince : presetSince(preset);
  const since = latestIso(presetBound, counterStart);
  const until = preset === "custom" ? customUntil : undefined;
  return {
    ...base,
    since,
    until,
  };
}

export function toDatetimeLocalValue(iso: string | undefined): string {
  if (iso === undefined) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDatetimeLocalValue(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const date = new Date(trimmed);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function fillTimeseriesGaps<T extends { bucket: string }>(
  points: T[],
  {
    since,
    until,
    bucket,
    now = new Date(),
    createEmpty,
  }: {
    since?: string;
    until?: string;
    bucket: UsageBucket;
    now?: Date;
    createEmpty: (bucketKey: string) => T;
  },
): T[] {
  if (points.length === 0 && since === undefined) return points;

  const byKey = new Map(points.map((point) => [point.bucket, point]));
  const start = since !== undefined ? new Date(since) : points.length > 0 ? new Date(points[0]!.bucket) : now;
  const end = until !== undefined ? new Date(until) : now;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start.getTime() > end.getTime()) {
    return points;
  }

  const cursor = new Date(start);
  if (bucket === "day") {
    cursor.setUTCHours(0, 0, 0, 0);
  } else {
    cursor.setUTCMinutes(0, 0, 0);
  }

  const filled: T[] = [];
  const stepMs = bucket === "day" ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const endMs = end.getTime();
  let guard = 0;
  while (cursor.getTime() <= endMs && guard < 4000) {
    const key =
      bucket === "day"
        ? cursor.toISOString().slice(0, 10)
        : `${cursor.toISOString().slice(0, 13)}:00:00.000Z`;
    filled.push(byKey.get(key) ?? createEmpty(key));
    cursor.setTime(cursor.getTime() + stepMs);
    guard += 1;
  }

  // Preserve any points outside the filled window (e.g. sparse historical data on "all").
  if (since === undefined) {
    for (const point of points) {
      if (!filled.some((item) => item.bucket === point.bucket)) filled.push(point);
    }
    filled.sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  return filled;
}
