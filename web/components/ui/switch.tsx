"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  hint,
  id,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
  id?: string;
}): React.ReactElement {
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex cursor-pointer items-center gap-3",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center transition-all",
          "shadow-edge",
          checked ? "bg-phosphor-100 shadow-edge-phosphor" : "bg-ink-700",
        )}
      >
        <span
          className={cn(
            "block h-3 w-3 transition-transform duration-150",
            checked ? "translate-x-5 bg-phosphor-500" : "translate-x-1 bg-bone-500",
          )}
        />
      </button>
      {(label !== undefined || hint !== undefined) && (
        <span className="flex flex-col">
          {label !== undefined ? (
            <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-700">
              {label}
            </span>
          ) : null}
          {hint !== undefined ? (
            <span className="font-mono text-[10px] text-bone-300">{hint}</span>
          ) : null}
        </span>
      )}
    </label>
  );
}
