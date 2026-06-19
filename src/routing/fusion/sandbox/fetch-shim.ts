import { createLogger } from "../../../observability/logger.ts";
import type { FetchShimConfig } from "./types.ts";

const log = createLogger("routing.fusion.sandbox.fetch");

// ── Default FetchShim config ──────────────────────────────────────────

export const DEFAULT_FETCH_SHIM_CONFIG: FetchShimConfig = {
  allowNetwork: true,
  allowedDomains: [],
  maxResponseBytes: 1_000_000, // 1 MB
  timeoutMs: 15_000, // 15 seconds
};

// ── FetchShim ─────────────────────────────────────────────────────────

/**
 * Controlled network proxy for the code execution sandbox.
 *
 * Wraps fetch() with:
 *  - Domain allow/block listing
 *  - Response size limits
 *  - Timeout enforcement
 *  - Structured logging for observability
 *
 * This is used by the WASM/subprocess runtime as a drop-in replacement
 * for `fetch` in untrusted code — all network requests are routed through
 * this shim before reaching the actual network.
 */
export class FetchShim {
  private readonly config: FetchShimConfig;

  constructor(config: Partial<FetchShimConfig> = {}) {
    this.config = { ...DEFAULT_FETCH_SHIM_CONFIG, ...config };
  }

  /**
   * Perform a fetch through the shim, enforcing security policies.
   *
   * @returns A Response-like object (subset of the real Response API).
   */
  async fetch(url: string, options: Record<string, unknown> = {}): Promise<FetchShimResponse> {
    const startTime = performance.now();

    // 1. Validate URL
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return {
        ok: false,
        status: 400,
        statusText: "Bad Request",
        body: JSON.stringify({ error: "Invalid URL" }),
        headers: { "content-type": "application/json" },
        durationMs: 0,
      };
    }

    // 2. Check network access
    if (!this.config.allowNetwork) {
      return {
        ok: false,
        status: 403,
        statusText: "Forbidden",
        body: JSON.stringify({ error: "Network access is disabled" }),
        headers: { "content-type": "application/json" },
        durationMs: 0,
      };
    }

    // 3. Check domain allowlist
    if (this.config.allowedDomains && this.config.allowedDomains.length > 0) {
      const hostname = parsedUrl.hostname.toLowerCase();
      const allowed = this.config.allowedDomains.some(
        (d) => hostname === d.toLowerCase() || hostname.endsWith("." + d.toLowerCase()),
      );
      if (!allowed) {
        log.warn("blocked fetch to disallowed domain", { url: parsedUrl.hostname });
        return {
          ok: false,
          status: 403,
          statusText: "Forbidden",
          body: JSON.stringify({ error: `Domain '${parsedUrl.hostname}' is not allowed` }),
          headers: { "content-type": "application/json" },
          durationMs: 0,
        };
      }
    }

    // 4. Execute fetch with timeout and size limit
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      } as RequestInit);

      clearTimeout(timeoutId);

      const durationMs = Math.round(performance.now() - startTime);

      // 5. Read body with size limit
      const reader = response.body?.getReader();
      let body = "";
      let totalBytes = 0;
      const decoder = new TextDecoder();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > this.config.maxResponseBytes) {
            reader.cancel();
            body += decoder.decode(value.slice(0, this.config.maxResponseBytes - (totalBytes - value.byteLength)));
            break;
          }
          body += decoder.decode(value, { stream: true });
        }
      } else {
        body = await response.text();
      }

      log.debug("fetch shim completed", {
        url: parsedUrl.hostname,
        status: response.status,
        bytes: totalBytes,
        durationMs,
      });

      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        body,
        headers: Object.fromEntries(response.headers.entries()),
        durationMs,
      };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);

      if (err instanceof DOMException && err.name === "AbortError") {
        log.warn("fetch shim timeout", { url: parsedUrl.hostname, timeoutMs: this.config.timeoutMs });
        return {
          ok: false,
          status: 504,
          statusText: "Gateway Timeout",
          body: JSON.stringify({ error: "Request timed out" }),
          headers: { "content-type": "application/json" },
          durationMs,
        };
      }

      log.error("fetch shim failed", { url: parsedUrl.hostname, error: String(err) });
      return {
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        body: JSON.stringify({ error: String(err) }),
        headers: { "content-type": "application/json" },
        durationMs,
      };
    }
  }
}

// ── Response Type ─────────────────────────────────────────────────────

export interface FetchShimResponse {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
  headers: Record<string, string>;
  durationMs: number;
}
