"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getAnalytics,
  getAnalyticsTimeseries,
  getLogs,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type ObservabilityFilters,
  type RequestLogRecord,
} from "@/lib/endpoints";
import { fillTimeseriesGaps, type UsageBucket } from "@/lib/usage-range";

export const USAGE_PAGE_SIZE = 250;

/** Single poller for the admin usage page: request log, analytics summary, and
 * timeseries are fetched together so every view reflects the same filters,
 * window, and refresh cycle. */
export function useUsagePageData({
  filters,
  bucket,
  offset,
  pollMs = 5000,
}: {
  filters: ObservabilityFilters;
  bucket: UsageBucket;
  offset: number;
  pollMs?: number;
}): {
  records: RequestLogRecord[];
  summary: AnalyticsSummary | undefined;
  points: AnalyticsTimeseriesPoint[];
  total: number;
  completed: number;
  active: number;
  hasMore: boolean;
  error: string | undefined;
  reload: () => Promise<void>;
} {
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [summary, setSummary] = useState<AnalyticsSummary | undefined>(undefined);
  const [rawPoints, setRawPoints] = useState<AnalyticsTimeseriesPoint[]>([]);
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [active, setActive] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const sequenceRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);
  const liveRef = useRef({ filters, bucket, offset });
  useEffect(() => {
    liveRef.current = { filters, bucket, offset };
  }, [filters, bucket, offset]);

  const reload = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    try {
      const current = liveRef.current;
      const [logs, analyticsResult, timeseriesResult] = await Promise.all([
        getLogs(USAGE_PAGE_SIZE, current.offset, current.filters),
        getAnalytics(current.filters),
        getAnalyticsTimeseries(current.filters, current.bucket),
      ]);
      if (sequence !== sequenceRef.current) return;
      setRecords(logs.records);
      setTotal(logs.total);
      setCompleted(logs.total_completed);
      setActive(logs.active_count);
      setHasMore(logs.has_more);
      setSummary(analyticsResult.summary);
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
      }
    }
  }, []);

  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
  useEffect(() => {
    void reload();
    const id = setInterval(() => {
      void reload();
    }, pollMs);
    return () => {
      clearInterval(id);
      // Discard any in-flight result for the old filters (or after unmount)
      // and drop queued refreshes so no new fetch chains after cleanup.
      sequenceRef.current += 1;
      pendingRef.current = false;
    };
  }, [bucket, filtersKey, offset, pollMs, reload]);

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

  return { records, summary, points, total, completed, active, hasMore, error, reload };
}
