"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Table({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <div className={cn("overflow-x-auto font-mono text-[12px]", className)}>
      <table className="w-full border-collapse">{children}</table>
    </div>
  );
}

export function Thead({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <thead className="bg-ink-700 text-bone-500">
      {children}
    </thead>
  );
}

export function Th({
  children,
  align = "left",
  width,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  width?: string;
}): React.ReactElement {
  return (
    <th
      className={cn(
        "border-b border-ink-500 px-4 py-2 text-[10px] uppercase tracking-[0.14em] font-normal",
        align === "right" && "text-right",
        align === "center" && "text-center",
        align === "left" && "text-left",
      )}
      style={width !== undefined ? { width } : undefined}
    >
      {children}
    </th>
  );
}

export function Tr({
  children,
  onClick,
  className,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <tr
      className={cn(
        "border-b border-ink-500 transition-colors",
        onClick !== undefined && "cursor-pointer hover:bg-ink-700/60",
        className,
      )}
      onClick={onClick}
      title={title}
    >
      {children}
    </tr>
  );
}

export function Td({
  children,
  align = "left",
  mono = true,
  className,
  title,
}: {
  children: ReactNode;
  align?: "left" | "right" | "center";
  mono?: boolean;
  className?: string;
  title?: string;
}): React.ReactElement {
  return (
    <td
      className={cn(
        "px-4 py-2.5 text-bone-700",
        align === "right" && "text-right",
        align === "center" && "text-center",
        mono ? "font-mono" : "font-sans",
        className,
      )}
      title={title}
    >
      {children}
    </td>
  );
}

export function EmptyRow({
  colSpan,
  children,
}: {
  colSpan: number;
  children: ReactNode;
}): React.ReactElement {
  return (
    <tr>
      <td
        colSpan={colSpan}
        className="px-4 py-16 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300"
      >
        {children}
      </td>
    </tr>
  );
}
