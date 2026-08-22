"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <header
      className={cn(
        "mb-8 flex flex-col gap-6 border-b border-ink-500 pb-6",
        "md:flex-row md:items-end md:justify-between",
        className,
      )}
    >
      <div className="space-y-3">
        {eyebrow !== undefined ? (
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-phosphor-500">
            /{eyebrow}
          </div>
        ) : null}
        <h1 className="font-mono text-[34px] font-medium leading-[1.05] tracking-tight text-bone-900 md:text-[44px]">
          {title}
        </h1>
        {description !== undefined ? (
          <p className="max-w-[58ch] text-sm text-bone-500">{description}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
