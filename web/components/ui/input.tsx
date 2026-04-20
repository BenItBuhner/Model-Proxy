"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  monospace?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, monospace = false, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "h-9 w-full bg-ink-700 px-3 text-sm text-bone-900 placeholder:text-bone-300",
          "shadow-edge focus:shadow-edge-phosphor focus:outline-none",
          "disabled:cursor-not-allowed disabled:opacity-50",
          monospace && "font-mono text-[13px]",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  monospace?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, monospace = true, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          "min-h-[120px] w-full resize-y bg-ink-700 px-3 py-2 text-sm text-bone-900 placeholder:text-bone-300",
          "shadow-edge focus:shadow-edge-phosphor focus:outline-none",
          monospace && "font-mono text-[12px] leading-6",
          className,
        )}
        {...props}
      />
    );
  },
);
Textarea.displayName = "Textarea";

export function Label({
  htmlFor,
  children,
  hint,
  className,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("flex items-baseline justify-between pb-1.5", className)}>
      <label
        htmlFor={htmlFor}
        className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-500"
      >
        {children}
      </label>
      {hint !== undefined ? (
        <span className="font-mono text-[10px] text-bone-300">{hint}</span>
      ) : null}
    </div>
  );
}
