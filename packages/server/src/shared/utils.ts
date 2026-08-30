import { createHash } from "node:crypto";

/** Parse a positive integer from an env-style string. Blank or invalid values yield undefined. */
export function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Read an integer env var with a fallback. Negative values fall back. */
export function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Narrow unknown to a plain object record. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolve after `ms`. Rejects with an AbortError when `signal` aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) return new Promise((resolve) => setTimeout(resolve, ms));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/** Combine abort signals so the returned signal aborts when any input aborts. */
export function mergeAbortSignals(
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 0) return undefined;
  if (real.length === 1) return real[0];
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of real) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

/** Rough chars/4 token estimate. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Rough token estimate over an array of messages. */
export function estimateMessageTokens(messages: unknown[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokens(JSON.stringify(message));
  }
  return total;
}

/** Deterministic JSON stringify: sorted keys, undefined values dropped. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

/** SHA-256 of the stable stringify of `value`. */
export function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Expand `${VAR_NAME}` references from process.env, leaving unknown vars intact. */
export function substituteEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
    return process.env[varName] ?? `\${${varName}}`;
  });
}
