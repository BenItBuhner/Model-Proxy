import { providerConfigLoader } from "../config/provider-loader.ts";
import type { ErrorAction } from "../providers/api-key-manager.ts";
import { resolveRetryAfterSeconds } from "../providers/egress-proxy-manager.ts";
import {
  ProviderAPIError,
  ProviderTimeoutError,
  RouteExecutionError,
} from "../providers/errors.ts";

/**
 * Pure error-classification helpers for the routing core: map upstream
 * failures to fallback actions, cooldowns, and log-safe summaries.
 */

const VERBOSE_HTTP_ERRORS =
  (process.env.VERBOSE_HTTP_ERRORS ?? "false").toLowerCase() === "true";

export interface ErrorActionResult {
  action: ErrorAction;
  cooldownSeconds?: number;
}

export function extractStatusCode(err: unknown): number | undefined {
  if (err instanceof ProviderAPIError) return err.status;
  if (err instanceof RouteExecutionError) return err.statusCode;
  if (err instanceof Error) {
    const maybeStatus = (err as unknown as { status?: unknown }).status;
    if (typeof maybeStatus === "number") return maybeStatus;
  }
  return undefined;
}

export function isAbortLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  if (
    error instanceof RouteExecutionError &&
    error.originalError !== undefined &&
    isAbortLikeError(error.originalError)
  ) {
    return true;
  }
  return /operation was aborted|request was aborted|aborterror/i.test(error.message);
}

export function isProviderTimeout(err: unknown): boolean {
  return (
    err instanceof ProviderTimeoutError ||
    (err instanceof RouteExecutionError &&
      err.originalError instanceof ProviderTimeoutError)
  );
}

export function isEmptyMeaningfulStreamError(err: unknown): boolean {
  if (!(err instanceof ProviderAPIError)) return false;
  const status = extractStatusCode(err);
  if (status !== 502) return false;
  return /stream ended before emitting meaningful content/i.test(err.message);
}

export function isFallbackWorthy(err: unknown): boolean {
  const status = extractStatusCode(err);
  if (status !== undefined) {
    if (status >= 400 && status < 600) return true;
  }
  if (isAbortLikeError(err)) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return /timeout|timed out|abort|aborted|connect|connection|network|unreachable|reset|failed to fetch|unexpected end|invalid json|json input|server error|internal server error|bad gateway|service unavailable|gateway timeout|too many requests|rate limit|temporarily|overloaded|capacity/.test(
      msg,
    );
  }
  return false;
}

export function shouldCooldownProxyForError(err: unknown): boolean {
  if (isProviderTimeout(err)) return true;
  const status = extractStatusCode(err);
  if (status !== undefined) return status === 502 || status === 503 || status === 504;
  if (err instanceof Error) {
    return /timeout|timed out|connect|connection|network|unreachable|reset|failed to fetch|unexpected end|invalid json|json input|gateway timeout/i.test(err.message);
  }
  return false;
}

export function formatErrorForLog(
  err: unknown,
  provider: string,
  model: string,
  apiKey: string | undefined,
): string {
  const parts = [`provider=${provider}`, `model=${model}`];
  const status = extractStatusCode(err);
  if (status !== undefined) parts.push(`status=${status}`);
  if (status === 401 && apiKey !== undefined) {
    const hint = apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "***";
    parts.push(`key=${hint}`);
  }
  const base = parts.join(", ");
  if (VERBOSE_HTTP_ERRORS) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${base}, error=${msg}`;
  }
  return base;
}

export function resolveErrorAction(
  providerName: string,
  err: unknown,
): ErrorActionResult {
  const status = extractStatusCode(err);
  if (isProviderTimeout(err)) return { action: "fallback_no_cooldown" };
  if (isAbortLikeError(err)) return { action: "fallback_no_cooldown" };
  if (isEmptyMeaningfulStreamError(err)) return { action: "fallback_no_cooldown" };
  if (status === undefined) return { action: "model_key_failure" };

  if (status === 429 && err instanceof ProviderAPIError) {
    const retryAfter = resolveRetryAfterSeconds(err, providerName);
    const body = err.body?.toLowerCase() ?? "";
    if (
      body.includes("freeusagelimiterror") ||
      body.includes("ratelimiterror") ||
      body.includes("free-models-per-day") ||
      body.includes("rate limit exceeded")
    ) {
      const out: ErrorActionResult = { action: "provider_cooldown" };
      if (retryAfter !== undefined) out.cooldownSeconds = retryAfter;
      return out;
    }
  }

  try {
    const cfg = providerConfigLoader.loadProvider(providerName);
    const handling = cfg.error_handling ?? {};
    const entry = handling[String(status)];
    if (entry !== undefined) {
      const action = entry.action as ErrorAction;
      const cooldown = (entry as { cooldown_seconds?: unknown }).cooldown_seconds;
      const out: ErrorActionResult = { action };
      if (typeof cooldown === "number") out.cooldownSeconds = cooldown;
      return out;
    }
  } catch {
    // fall through to defaults
  }

  if (status === 401 || status === 403) return { action: "global_key_failure" };
  return { action: "model_key_failure" };
}
