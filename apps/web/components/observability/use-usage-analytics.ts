"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAnalytics,
  getAnalyticsTimeseries,
  getCurrentUserAnalytics,
  getCurrentUserAnalyticsTimeseries,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type ObservabilityFilters,
} from "@/lib/endpoints";
import { fillTimeseriesGaps, type UsageBucket } from "@/lib/usage-range";

export type UsageAudience = "admin" | "user";

/** Fetches the analytics summary + timeseries for externally-owned filters and
 * bucket. Callers own the time-range/filter state; this hook only handles
 * fetching, polling, and stale-response races. */
export function useUsageAnalytics({
  audience,
  filters,
  bucket,
  pollMs = 5000,
}: {
  audience: UsageAudience;
  filters: ObservabilityFilters;
  bucket: UsageBucket;
  pollMs?: number;
}): {
  summary: AnalyticsSummary | undefined;
  points: AnalyticsTimeseriesPoint[];
  loading: boolean;
  error: string | undefined;
  reload: () => Promise<void>;
} {
  const [summary, setSummary] = useState<AnalyticsSummary | undefined>(undefined);
  const [rawPoints, setRawPoints] = useState<AnalyticsTimeseriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const sequenceRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const liveRef = useRef({ filters, bucket, audience });
  useEffect(() => {
    liveRef.current = { filters, bucket, audience };
  }, [filters, bucket, audience]);

  const reload = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      // A filter/bucket change arrived mid-flight; refetch when it settles.
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    try {
      const current = liveRef.current;
      const fetchSummary = current.audience === "admin" ? getAnalytics : getCurrentUserAnalytics;
      const fetchTimeseries =
        current.audience === "admin"
          ? getAnalyticsTimeseries
          : getCurrentUserAnalyticsTimeseries;
      const [summaryResult, timeseriesResult] = await Promise.all([
        fetchSummary(current.filters),
        fetchTimeseries(current.filters, current.bucket),
      ]);
      if (sequence !== sequenceRef.current) return;
      setSummary(summaryResult.summary);
      setRawPoints(timeseriesResult.points);
      setError(undefined);
    } catch (err) {
      if (sequence !== sequenceRef.current) return;
      setError((err as Error).message);
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void reload();
      } else if (sequence === sequenceRef.current) {
        setLoading(false);
      }
    }
  }, []);

  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
  useEffect(() => {
    sequenceRef.current += 1; // discard any in-flight result for the old filters
    void reload();
    const id = setInterval(() => {
      void reload();
    }, pollMs);
    return () => clearInterval(id);
  }, [bucket, filtersKey, pollMs, reload]);

  const points = useMemo(
    () =>
      fillTimeseriesGaps(rawPoints, {
        since: filters.since,
        until: filters.until,
        bucket,
        createEmpty: (bucketKey) => ({
          bucket: bucketKey,
          requests: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          userCostUsd: 0,
          typicalCostUsd: 0,
          savedCostUsd: 0,
        }),
      }),
    [bucket, filters.since, filters.until, rawPoints],
  );

  return { summary, points, loading, error, reload };
}
