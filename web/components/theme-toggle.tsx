"use client";

import { useTheme } from "@/components/theme-provider";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export function ThemeToggle({
  className,
}: {
  className?: string;
}): React.ReactElement {
  const { theme, setTheme } = useTheme();

  return (
    <div className={cn("space-y-2", className)}>
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
        Theme
      </div>
      <div
        className="grid grid-cols-3 gap-px bg-ink-500 p-px shadow-edge"
        role="radiogroup"
        aria-label="Color theme"
      >
        {OPTIONS.map((option) => {
          const active = theme === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setTheme(option.value)}
              className={cn(
                "px-2 py-1.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-colors",
                active
                  ? "bg-phosphor-500 text-ink-900"
                  : "bg-ink-700 text-bone-500 hover:bg-ink-600 hover:text-bone-700",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
