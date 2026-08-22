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
import { useUsageAnalytics, type UsageAudience } from "./use-usage-analytics";

export function UsageDashboard({
  audience,
  baseFilters = {},
  scope,
  showCostSettingsSlot,
}: {
  audience: UsageAudience;
  baseFilters?: ObservabilityFilters;
  scope?: string;
  showCostSettingsSlot?: React.ReactNode;
}): React.ReactElement {
  const [chartMetric, setChartMetric] = useState<"both" | "tokens" | "cost">("both");
  const usage = useUsageAnalytics({ audience, baseFilters, scope });

  return (
    <div className="space-y-5">
      <UsageTimeRangeControls
        preset={usage.preset}
        onPresetChange={usage.setPreset}
        customSince={usage.customSince}
        customUntil={usage.customUntil}
        onCustomRangeChange={usage.setCustomRange}
        counterStart={usage.counterStart}
        onCounterStartChange={usage.setCounterStart}
        bucket={usage.bucket}
        onBucketChange={usage.setBucket}
      />

      {usage.error !== undefined ? (
        <div className="flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{usage.error}</span>
        </div>
      ) : null}

      {showCostSettingsSlot}

      <div className="flex items-center justify-between gap-3">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
          {usage.loading && usage.summary === undefined ? "loading usage…" : "usage window"}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void usage.reload()}>
          refresh
        </Button>
      </div>

      <AnalyticsDashboard summary={usage.summary} emphasizeSpend />

      <Panel
        title="usage trends"
        subtitle={`hover any point · ${usage.bucket} buckets`}
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
          <UsageTrendChart points={usage.points} bucket={usage.bucket} metric={chartMetric} />
        </PanelBody>
      </Panel>

      <Panel title="route breakdown" subtitle="tokens and dollars by provider / model / key" accent>
        <UsageBreakdownTable summary={usage.summary} />
      </Panel>
    </div>
  );
}
