"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function Panel({
  children,
  className,
  bodyClassName,
  title,
  subtitle,
  badge,
  accent = false,
  toolbar,
}: {
  children: React.ReactNode;
  className?: string;
  /** Wrapper around `children` (below the optional header). */
  bodyClassName?: string;
  title?: string;
  subtitle?: React.ReactNode;
  badge?: React.ReactNode;
  accent?: boolean;
  toolbar?: React.ReactNode;
}): React.ReactElement {
  return (
    <section
      className={cn(
        "relative bg-ink-800 shadow-edge",
        accent && "corners",
        className,
      )}
    >
      {(title !== undefined || toolbar !== undefined) && (
        <header className="flex items-center justify-between gap-4 border-b border-ink-500 px-5 py-3">
          <div className="flex items-center gap-3 min-w-0">
            {title !== undefined ? (
              <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-bone-700">
                {title}
              </h2>
            ) : null}
            {badge !== undefined ? <span>{badge}</span> : null}
            {subtitle !== undefined ? (
              <span className="truncate font-mono text-[11px] text-bone-300">
                {subtitle}
              </span>
            ) : null}
          </div>
          {toolbar !== undefined ? (
            <div className="flex items-center gap-2">{toolbar}</div>
          ) : null}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}

export function PanelBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return <div className={cn("p-5", className)}>{children}</div>;
}
