"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getAnalytics,
  getAnalyticsTimeseries,
  getCurrentUserAnalytics,
  getCurrentUserAnalyticsTimeseries,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type ObservabilityFilters,
} from "@/lib/endpoints";
import {
  fillTimeseriesGaps,
  mergeUsageFilters,
  readCounterStart,
  suggestedBucket,
  type UsageBucket,
  type UsagePreset,
  writeCounterStart,
} from "@/lib/usage-range";

export type UsageAudience = "admin" | "user";

export function useUsageAnalytics({
  audience,
  baseFilters = {},
  scope,
  pollMs = 8000,
}: {
  audience: UsageAudience;
  baseFilters?: ObservabilityFilters;
  scope?: string;
  pollMs?: number;
}): {
  preset: UsagePreset;
  setPreset: (preset: UsagePreset) => void;
  customSince: string | undefined;
  customUntil: string | undefined;
  setCustomRange: (since: string | undefined, until: string | undefined) => void;
  counterStart: string | undefined;
  setCounterStart: (iso: string | undefined) => void;
  bucket: UsageBucket;
  setBucket: (bucket: UsageBucket) => void;
  filters: ObservabilityFilters;
  summary: AnalyticsSummary | undefined;
  points: AnalyticsTimeseriesPoint[];
  loading: boolean;
  error: string | undefined;
  reload: () => Promise<void>;
} {
  const [preset, setPreset] = useState<UsagePreset>("7d");
  const [customSince, setCustomSince] = useState<string | undefined>(undefined);
  const [customUntil, setCustomUntil] = useState<string | undefined>(undefined);
  const [counterStart, setCounterStartState] = useState<string | undefined>(undefined);
  const [bucketOverride, setBucketOverride] = useState<UsageBucket | undefined>(undefined);
  const [summary, setSummary] = useState<AnalyticsSummary | undefined>(undefined);
  const [rawPoints, setRawPoints] = useState<AnalyticsTimeseriesPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    setCounterStartState(readCounterStart(scope));
  }, [scope]);

  const filters = useMemo(
    () =>
      mergeUsageFilters({
        base: baseFilters,
        preset,
        customSince,
        customUntil,
        counterStart,
      }),
    [baseFilters, counterStart, customSince, customUntil, preset],
  );

  const bucket = bucketOverride ?? suggestedBucket(filters.since, filters.until);

  const setCounterStart = useCallback(
    (iso: string | undefined): void => {
      writeCounterStart(iso, scope);
      setCounterStartState(iso);
    },
    [scope],
  );

  const setCustomRange = useCallback((since: string | undefined, until: string | undefined): void => {
    setCustomSince(since);
    setCustomUntil(until);
    setPreset("custom");
    setBucketOverride(undefined);
  }, []);

  const setPresetAndResetBucket = useCallback((next: UsagePreset): void => {
    setPreset(next);
    setBucketOverride(undefined);
  }, []);

  const reload = useCallback(async () => {
    try {
      const fetchSummary = audience === "admin" ? getAnalytics : getCurrentUserAnalytics;
      const fetchTimeseries =
        audience === "admin" ? getAnalyticsTimeseries : getCurrentUserAnalyticsTimeseries;
      const [summaryResult, timeseriesResult] = await Promise.all([
        fetchSummary(filters),
        fetchTimeseries(filters, bucket),
      ]);
      setSummary(summaryResult.summary);
      setRawPoints(timeseriesResult.points);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [audience, bucket, filters]);

  useEffect(() => {
    setLoading(true);
    void reload();
    const id = setInterval(() => {
      void reload();
    }, pollMs);
    return () => clearInterval(id);
  }, [pollMs, reload]);

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

  return {
    preset,
    setPreset: setPresetAndResetBucket,
    customSince,
    customUntil,
    setCustomRange,
    counterStart,
    setCounterStart,
    bucket,
    setBucket: (next: UsageBucket) => setBucketOverride(next),
    filters,
    summary,
    points,
    loading,
    error,
    reload,
  };
}
