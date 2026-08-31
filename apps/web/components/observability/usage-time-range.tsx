"use client";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  fromDatetimeLocalValue,
  toDatetimeLocalValue,
  type UsageBucket,
  type UsagePreset,
} from "@/lib/usage-range";
import { cn } from "@/lib/utils";

const PRESETS: Array<{ id: UsagePreset; label: string }> = [
  { id: "24h", label: "24h" },
  { id: "7d", label: "7d" },
  { id: "30d", label: "30d" },
  { id: "90d", label: "90d" },
  { id: "all", label: "All" },
  { id: "custom", label: "Custom" },
];

export function UsageTimeRangeControls({
  preset,
  onPresetChange,
  customSince,
  customUntil,
  onCustomRangeChange,
  counterStart,
  onCounterStartChange,
  bucket,
  onBucketChange,
}: {
  preset: UsagePreset;
  onPresetChange: (preset: UsagePreset) => void;
  customSince: string | undefined;
  customUntil: string | undefined;
  onCustomRangeChange: (since: string | undefined, until: string | undefined) => void;
  counterStart: string | undefined;
  onCounterStartChange: (iso: string | undefined) => void;
  bucket: UsageBucket;
  onBucketChange: (bucket: UsageBucket) => void;
}): React.ReactElement {
  return (
    <div className="space-y-4 bg-ink-800 p-4 shadow-edge">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div className="space-y-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
            time frame
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Time frame">
            {PRESETS.map((item) => {
              const active = item.id === preset;
              return (
                <button
                  key={item.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onPresetChange(item.id)}
                  className={cn(
                    "h-8 px-3 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500",
                    active
                      ? "bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                      : "bg-ink-700 text-bone-500 hover:bg-ink-600 hover:text-bone-900",
                  )}
                >
                  {item.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
            bucket
          </div>
          <div className="flex gap-1" role="group" aria-label="Bucket size">
            {(["hour", "day"] as const).map((option) => {
              const active = option === bucket;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onBucketChange(option)}
                  className={cn(
                    "h-8 px-3 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors",
                    "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500",
                    active
                      ? "bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                      : "bg-ink-700 text-bone-500 hover:bg-ink-600 hover:text-bone-900",
                  )}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {preset === "custom" ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="From">
            <Input
              type="datetime-local"
              value={toDatetimeLocalValue(customSince)}
              onChange={(event) =>
                onCustomRangeChange(fromDatetimeLocalValue(event.target.value), customUntil)
              }
              monospace
            />
          </Field>
          <Field label="Until">
            <Input
              type="datetime-local"
              value={toDatetimeLocalValue(customUntil)}
              onChange={(event) =>
                onCustomRangeChange(customSince, fromDatetimeLocalValue(event.target.value))
              }
              monospace
            />
          </Field>
        </div>
      ) : null}

      <div className="border-t border-ink-500 pt-4">
        <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
          personal counter
        </div>
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
          <Field label="Count from">
            <Input
              type="datetime-local"
              value={toDatetimeLocalValue(counterStart)}
              onChange={(event) => onCounterStartChange(fromDatetimeLocalValue(event.target.value))}
              monospace
            />
          </Field>
          <div className="flex items-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="md"
              onClick={() => onCounterStartChange(new Date().toISOString())}
            >
              start now
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="md"
              onClick={() => onCounterStartChange(undefined)}
              disabled={counterStart === undefined}
            >
              clear
            </Button>
          </div>
        </div>
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-300">
          {counterStart !== undefined
            ? `Counter floor applied · totals start at ${formatFriendly(counterStart)}`
            : "Optional · set any start time to reset your personal usage counter"}
        </p>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function formatFriendly(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
