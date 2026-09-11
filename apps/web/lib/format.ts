/** Shared display formatting helpers (single source; no per-page copies). */

export function formatCount(value: number | undefined): string {
  return new Intl.NumberFormat("en-US").format(value ?? 0);
}

export function formatUsd(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(6)}`;
}

export function formatLimit(value: number | undefined): string {
  return value === undefined ? "unlimited" : formatCount(value);
}

export function formatUsdLimit(value: number | undefined): string {
  return value === undefined ? "unlimited" : `$${value.toFixed(2)}`;
}

export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatTokensPerSecond(value: number | undefined): string {
  if (value === undefined) return "-";
  return `${value.toFixed(1)} tok/s`;
}

export function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/** Ratio -> percentage string: 0.987 -> "98.70%". */
export function formatPercent(ratio: number | undefined, digits = 2): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "-";
  return `${(ratio * 100).toFixed(digits)}%`;
}
