import { mergeAbortSignals } from "../shared/utils.ts";
/**
 * Proxy-aware upstream fetch wrapper. Uses Bun's native `proxy` fetch option.
 */

import { ProviderTimeoutError } from "./errors.ts";

export type UpstreamFetcher = (input: string | URL | Request, init?: RequestInit & { proxy?: string }) => Promise<Response>;

export interface UpstreamFetchOptions extends RequestInit {
  proxy?: string;
  timeoutMs?: number;
  fetcher?: UpstreamFetcher;
}


export async function upstreamFetch(
  url: string,
  options: UpstreamFetchOptions = {},
): Promise<Response> {
  const { proxy, timeoutMs, signal, fetcher = fetch, ...init } = options;

  let timeoutSignal: AbortSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const controller = new AbortController();
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timeoutSignal = controller.signal;
  }

  const combinedSignal = mergeAbortSignals(
    signal ?? undefined,
    timeoutSignal,
  );

  try {
    const fetchInit: RequestInit & { proxy?: string } = {
      ...init,
      ...(combinedSignal !== undefined ? { signal: combinedSignal } : {}),
    };
    if (proxy !== undefined && proxy.length > 0) {
      fetchInit.proxy = proxy;
    }
    return await fetcher(url, fetchInit);
  } catch (err) {
    if (timedOut && signal?.aborted !== true) {
      throw new ProviderTimeoutError(
        `Upstream request timed out after ${timeoutMs}ms`,
        timeoutMs ?? 0,
        { cause: err },
      );
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Read a response body with a hard deadline.
 *
 * `upstreamFetch`'s timeout only covers the header phase — once a Response is
 * returned, an upstream that goes silent mid-body would hang `json()`/`text()`
 * forever. This helper races the body read against a timer and throws
 * ProviderTimeoutError on stall. (The body cancel is best-effort: a stream
 * locked by an in-flight `json()` read can't be cancelled and is left for GC.)
 */
export async function readBodyWithDeadline<T>(
  response: Response,
  read: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => {});
      reject(
        new ProviderTimeoutError(
          `Upstream response body stalled; no completion within ${timeoutMs}ms`,
          timeoutMs,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function parseRetryAfterHeader(
  response: Response,
): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null || raw.length === 0) return undefined;
  const seconds = Number.parseInt(raw, 10);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  }
  return undefined;
}

export function parseRetryAfterFromErrorBody(body: string | undefined): number | undefined {
  if (body === undefined || body.length === 0) return undefined;
  if (!body.includes("FreeUsageLimitError") && !body.includes("RateLimitError")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const metadata = parsed["metadata"];
    if (metadata !== null && typeof metadata === "object") {
      const retryAfter = (metadata as Record<string, unknown>)["retryAfter"];
      if (typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
        return Math.max(0, Math.floor(retryAfter));
      }
    }
  } catch {
    // ignore malformed JSON
  }
  return undefined;
}
