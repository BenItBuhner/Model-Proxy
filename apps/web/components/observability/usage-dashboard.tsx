"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody } from "@/components/ui/panel";
import { StatusDot } from "@/components/ui/badge";
import type { ObservabilityFilters } from "@/lib/endpoints";
import { cn } from "@/lib/utils";
import { AnalyticsDashboard } from "./analytics-dashboard";
import { UsageBreakdownTable } from "./usage-breakdown";
import { UsageTimeRangeControls } from "./usage-time-range";
import { UsageTrendChart } from "./usage-trend-chart";
import { useUsageAnalytics } from "./use-usage-analytics";
import { useUsageRange } from "./use-usage-range";

export function UsageDashboard({
  audience,
  baseFilters = {},
  scope,
  showCostSettingsSlot,
}: {
  audience: "admin" | "user";
  baseFilters?: ObservabilityFilters;
  scope?: string;
  showCostSettingsSlot?: React.ReactNode;
}): React.ReactElement {
  const [chartMetric, setChartMetric] = useState<"both" | "tokens" | "cost">("both");
  const range = useUsageRange(scope);
  const filters = { ...baseFilters, since: range.since, until: range.until };
  const { summary, points, loading, error, reload } = useUsageAnalytics({
    audience,
    filters,
    bucket: range.bucket,
  });

  return (
    <div className="space-y-5">
      <UsageTimeRangeControls
        preset={range.preset}
        onPresetChange={range.setPreset}
        customSince={range.customSince}
        customUntil={range.customUntil}
        onCustomRangeChange={range.setCustomRange}
        counterStart={range.counterStart}
        onCounterStartChange={range.setCounterStart}
        bucket={range.bucket}
        onBucketChange={range.setBucket}
      />

      {error !== undefined ? (
        <div className="flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      {showCostSettingsSlot}

      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
          {loading && summary === undefined ? "loading usage…" : "usage window"}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
          refresh
        </Button>
      </div>

      <AnalyticsDashboard summary={summary} />

      <Panel
        title="usage trends"
        subtitle={`hover any point · ${range.bucket} buckets`}
        accent
        toolbar={
          <div className="flex gap-1" role="group" aria-label="Chart metric">
            {(
              [
                { id: "both", label: "Both" },
                { id: "tokens", label: "Tokens" },
                { id: "cost", label: "Dollars" },
              ] as const
            ).map((option) => {
              const active = option.id === chartMetric;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setChartMetric(option.id)}
                  className={cn(
                    "h-7 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500",
                    active
                      ? "bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                      : "text-bone-500 hover:bg-ink-700 hover:text-bone-900",
                  )}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        }
      >
        <PanelBody>
          <UsageTrendChart points={points} bucket={range.bucket} metric={chartMetric} />
        </PanelBody>
      </Panel>

      <Panel title="route breakdown" subtitle="tokens and dollars by provider / model" accent>
        <UsageBreakdownTable summary={summary} />
      </Panel>
    </div>
  );
}
