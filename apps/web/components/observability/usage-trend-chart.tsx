"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsTimeseriesPoint } from "@/lib/endpoints";
import { formatCount, formatUsd } from "@/lib/format";
import type { UsageBucket } from "@/lib/usage-range";

type ChartRow = AnalyticsTimeseriesPoint & {
  label: string;
  fullLabel: string;
};

export function UsageTrendChart({
  points,
  bucket,
  metric = "both",
}: {
  points: AnalyticsTimeseriesPoint[];
  bucket: UsageBucket;
  metric?: "tokens" | "cost" | "both";
}): React.ReactElement {
  const data: ChartRow[] = points.map((point) => ({
    ...point,
    label: formatBucketLabel(point.bucket, bucket),
    fullLabel: formatBucketFull(point.bucket, bucket),
  }));

  if (data.length === 0) {
    return (
      <div className="flex h-[280px] items-center justify-center font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">
        no usage in this window
      </div>
    );
  }

  const showTokens = metric === "tokens" || metric === "both";
  const showCost = metric === "cost" || metric === "both";

  return (
    <div className="h-[320px] w-full animate-flicker-in">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 12, right: 16, left: 4, bottom: 8 }}>
          <defs>
            <linearGradient id="usageTokensFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="rgb(var(--color-phosphor-500))" stopOpacity={0.35} />
              <stop offset="100%" stopColor="rgb(var(--color-phosphor-500))" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="rgb(var(--color-ink-400))" strokeDasharray="3 6" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "rgb(var(--color-bone-300))", fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
            tickLine={false}
            axisLine={{ stroke: "rgb(var(--color-ink-400))" }}
            minTickGap={28}
          />
          {showTokens ? (
            <YAxis
              yAxisId="tokens"
              tick={{ fill: "rgb(var(--color-bone-300))", fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
              tickLine={false}
              axisLine={false}
              width={52}
              tickFormatter={(value: number) => compactCount(value)}
            />
          ) : null}
          {showCost ? (
            <YAxis
              yAxisId="cost"
              orientation={showTokens ? "right" : "left"}
              tick={{ fill: "rgb(var(--color-bone-300))", fontSize: 10, fontFamily: "JetBrains Mono, monospace" }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(value: number) => `$${compactMoney(value)}`}
            />
          ) : null}
          <Tooltip
            cursor={{ stroke: "rgb(var(--color-phosphor-500))", strokeOpacity: 0.35 }}
            content={<UsageTooltip />}
          />
          <Legend
            wrapperStyle={{
              fontFamily: "JetBrains Mono, monospace",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.14em",
              color: "rgb(var(--color-bone-500))",
            }}
          />
          {showTokens ? (
            <Area
              yAxisId="tokens"
              type="monotone"
              dataKey="totalTokens"
              name="Tokens"
              stroke="rgb(var(--color-phosphor-500))"
              fill="url(#usageTokensFill)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "rgb(var(--color-phosphor-500))" }}
              isAnimationActive
              animationDuration={650}
            />
          ) : null}
          {showCost ? (
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="userCostUsd"
              name="Spend $"
              stroke="rgb(var(--color-bone-700))"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: "rgb(var(--color-bone-900))" }}
              isAnimationActive
              animationDuration={650}
            />
          ) : null}
          {showCost ? (
            <Line
              yAxisId="cost"
              type="monotone"
              dataKey="savedCostUsd"
              name="Saved $"
              stroke="rgb(var(--color-phosphor-300))"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              activeDot={{ r: 3, fill: "rgb(var(--color-phosphor-300))" }}
              isAnimationActive
              animationDuration={650}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function UsageTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartRow }>;
}): React.ReactElement | null {
  if (!active || payload === undefined || payload.length === 0) return null;
  const point = payload[0]?.payload;
  if (point === undefined) return null;

  return (
    <div className="min-w-[220px] border border-ink-300 bg-ink-850 px-3 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.45)]">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-phosphor-500">
        {point.fullLabel}
      </div>
      <div className="mt-3 space-y-1.5 font-mono text-[11px] text-bone-700">
        <TooltipRow label="Requests" value={formatCount(point.requests)} />
        <TooltipRow label="Tokens" value={formatCount(point.totalTokens)} />
        <TooltipRow
          label="In / Out"
          value={`${formatCount(point.promptTokens ?? 0)} / ${formatCount(point.completionTokens ?? 0)}`}
        />
        <TooltipRow label="Spend" value={formatUsd(point.userCostUsd)} />
        <TooltipRow label="Typical" value={formatUsd(point.typicalCostUsd)} />
        <TooltipRow label="Saved" value={formatUsd(point.savedCostUsd)} />
      </div>
    </div>
  );
}

function TooltipRow({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="uppercase tracking-[0.12em] text-bone-300">{label}</span>
      <span className="text-bone-900">{value}</span>
    </div>
  );
}

function formatBucketLabel(bucket: string, mode: UsageBucket): string {
  if (mode === "day") {
    const date = new Date(`${bucket}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return bucket.slice(5);
    // Day buckets are UTC dates; render them in UTC so users west of UTC
    // don't see every label shifted a day earlier.
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  }
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket.slice(11, 16);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit" });
}

function formatBucketFull(bucket: string, mode: UsageBucket): string {
  if (mode === "day") {
    const date = new Date(`${bucket}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime())) return bucket;
    return date.toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  }
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  return date.toLocaleString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function compactMoney(value: number): string {
  if (value >= 100) return value.toFixed(0);
  if (value >= 1) return value.toFixed(2);
  if (value >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}
