"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "ghost" | "outline" | "danger";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
}

const base =
  "inline-flex items-center justify-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] " +
  "transition-all duration-150 disabled:cursor-not-allowed disabled:opacity-40 " +
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500";

const sizes: Record<NonNullable<ButtonProps["size"]>, string> = {
  sm: "h-7 px-3",
  md: "h-9 px-4",
  lg: "h-11 px-5 text-xs",
};

const variants: Record<ButtonVariant, string> = {
  primary:
    "bg-phosphor-500 text-ink-900 hover:bg-phosphor-400 active:bg-phosphor-300 shadow-[0_0_0_1px_rgba(205,255,0,0.85)]",
  ghost:
    "bg-transparent text-bone-700 hover:bg-ink-500 hover:text-bone-900",
  outline:
    "bg-transparent text-bone-700 shadow-edge hover:shadow-edge-phosphor hover:text-bone-900",
  danger:
    "bg-alert-500 text-ink-900 hover:brightness-110",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(base, sizes[size], variants[variant], className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
