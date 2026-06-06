/**
 * Proxy-aware upstream fetch wrapper. Uses Bun's native `proxy` fetch option.
 */

export type UpstreamFetcher = (input: string | URL | Request, init?: RequestInit & { proxy?: string }) => Promise<Response>;

export interface UpstreamFetchOptions extends RequestInit {
  proxy?: string;
  timeoutMs?: number;
  fetcher?: UpstreamFetcher;
}

function mergeAbortSignals(
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

export async function upstreamFetch(
  url: string,
  options: UpstreamFetchOptions = {},
): Promise<Response> {
  const { proxy, timeoutMs, signal, fetcher = fetch, ...init } = options;

  let timeoutSignal: AbortSignal | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
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
