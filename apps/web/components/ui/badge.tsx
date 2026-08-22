"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type BadgeTone = "phosphor" | "bone" | "warning" | "danger" | "muted";

export function Badge({
  children,
  tone = "bone",
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}): React.ReactElement {
  const toneClasses: Record<BadgeTone, string> = {
    phosphor: "text-phosphor-500 shadow-[inset_0_0_0_1px_rgba(205,255,0,0.4)] bg-phosphor-50",
    bone: "text-bone-700 shadow-edge bg-ink-700",
    warning: "text-[#FFB627] shadow-[inset_0_0_0_1px_rgba(255,182,39,0.35)] bg-[rgba(255,182,39,0.08)]",
    danger: "text-alert-500 shadow-[inset_0_0_0_1px_rgba(255,59,48,0.4)] bg-[rgba(255,59,48,0.08)]",
    muted: "text-bone-300 shadow-edge bg-ink-800",
  };
  return (
    <span
      className={cn(
        "inline-flex h-[20px] items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.14em]",
        toneClasses[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone = "phosphor" }: { tone?: BadgeTone }): React.ReactElement {
  const colorMap: Record<BadgeTone, string> = {
    phosphor: "bg-phosphor-500",
    bone: "bg-bone-500",
    warning: "bg-[#FFB627]",
    danger: "bg-alert-500",
    muted: "bg-bone-300",
  };
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 rounded-full shadow-[0_0_8px_rgba(205,255,0,0.55)]",
        colorMap[tone],
      )}
    />
  );
}
