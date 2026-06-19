"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAnalytics,
  getLogs,
  type AnalyticsSummary,
  type ObservabilityFilters,
  type RequestLogRecord,
} from "@/lib/endpoints";

export const OBSERVABILITY_PAGE_SIZE = 250;

export function useObservabilityData(filters: ObservabilityFilters, offset: number): {
  records: RequestLogRecord[];
  summary: AnalyticsSummary | undefined;
  total: number;
  completed: number;
  active: number;
  hasMore: boolean;
  error: string | undefined;
  reload: () => Promise<void>;
} {
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [summary, setSummary] = useState<AnalyticsSummary | undefined>(undefined);
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [active, setActive] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const [logs, analytics] = await Promise.all([
        getLogs(OBSERVABILITY_PAGE_SIZE, offset, filters),
        getAnalytics(filters),
      ]);
      setRecords(logs.records);
      setTotal(logs.total);
      setCompleted(logs.total_completed);
      setActive(logs.active_count);
      setHasMore(logs.has_more);
      setSummary(analytics.summary);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [filters, offset]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 4000);
    return () => clearInterval(id);
  }, [reload]);

  return { records, summary, total, completed, active, hasMore, error, reload };
}
