"use client";

import { StatusDot } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export function MetricCard({
  label,
  value,
  sublabel,
  tone,
  delta,
  deltaTitle,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: "phosphor";
  /** Percent change vs the previous window; rendered as a neutral chip. */
  delta?: number;
  deltaTitle?: string;
}): React.ReactElement {
  return (
    <div className="corners bg-ink-800 px-5 py-5 shadow-edge">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
          {label}
        </div>
        {delta !== undefined ? (
          <span
            title={deltaTitle}
            className={cn(
              "font-mono text-[10px] tracking-[0.08em]",
              delta > 0.05 ? "text-phosphor-500" : delta < -0.05 ? "text-alert-500" : "text-bone-300",
            )}
          >
            {delta > 0 ? "▲" : delta < 0 ? "▼" : "•"} {Math.abs(delta) >= 100 ? Math.round(Math.abs(delta)) : Math.abs(delta).toFixed(1)}%
          </span>
        ) : tone === "phosphor" ? (
          <StatusDot />
        ) : null}
      </div>
      <div className="mt-3 font-mono text-[28px] text-bone-900 leading-none">
        {value}
      </div>
      {sublabel !== undefined ? (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-500">
          {sublabel}
        </div>
      ) : null}
    </div>
  );
}

export function KV({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
        {label}
      </span>
      <span
        className={
          emphasis
            ? "font-mono text-[18px] text-bone-900"
            : "break-all text-right font-mono text-[11px] text-bone-700"
        }
      >
        {value}
      </span>
    </div>
  );
}
