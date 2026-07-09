"use client";

import { MetricWidget, formatCount, formatDurationMs, formatUsd } from "./metric-widget";
import type { AnalyticsSummary } from "@/lib/endpoints";

export function AnalyticsDashboard({
  summary,
}: {
  summary: AnalyticsSummary | undefined;
}): React.ReactElement {
  const cacheRate =
    summary !== undefined && summary.completedRequests > 0
      ? Math.round((summary.cacheHits / summary.completedRequests) * 100)
      : 0;
  return (
    <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
      <MetricWidget
        label="Total tokens"
        value={formatCount(summary?.totalTokens)}
        sublabel={`${formatCount(summary?.promptTokens)} in · ${formatCount(summary?.completionTokens)} out`}
      />
      <MetricWidget
        label="Saved cost"
        value={formatUsd(summary?.savedCostUsd)}
        sublabel={`${formatUsd(summary?.typicalCostUsd)} typical · ${formatUsd(summary?.userCostUsd)} user`}
      />
      <MetricWidget
        label="Cache hits"
        value={`${cacheRate}%`}
        sublabel={`${formatCount(summary?.matchedTokens)} matched tokens`}
      />
      <MetricWidget
        label="Requests"
        value={formatCount(summary?.totalRequests)}
        sublabel={`${formatCount(summary?.activeRequests)} running · p95 ${formatDurationMs(summary?.p95LatencyMs)}`}
      />
    </div>
  );
}
