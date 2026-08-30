import type { Context } from "hono";

/**
 * CSRF-style same-origin gate for mutating requests. GET/HEAD/OPTIONS pass;
 * everything else must present an Origin whose HOST matches one reported by
 * any layer of the proxy chain (request URL, Host header, X-Forwarded-Host)
 * or a configured CORS origin.
 *
 * The comparison is scheme-agnostic on purpose: behind TLS-terminating proxies
 * (Cloudflare Tunnel -> Caddy -> container) the app sees `http://` while the
 * browser Origin is `https://`, and strict origin equality would 403 every
 * mutation. Comparing hosts only is still safe for CSRF - a cross-site attacker
 * cannot make the victim's browser send a Host header for the target site.
 *
 * CORS_ORIGINS="*" is an explicit operator escape hatch that skips the check.
 */
export function isSameOriginMutation(c: Context): boolean {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.method === "OPTIONS") return true;
  const rawOrigin = c.req.header("origin");
  if (rawOrigin === undefined) return true;
  const originHost = hostOf(rawOrigin);
  if (originHost === undefined) return false; // malformed (e.g. Origin: null)
  if ((process.env.CORS_ORIGINS ?? "").trim() === "*") return true;

  const allowedHosts = new Set<string>();
  for (const value of headerValues(c.req.header("x-forwarded-host"))) addHost(allowedHosts, value);
  for (const value of headerValues(c.req.header("host"))) addHost(allowedHosts, value);
  try {
    addHost(allowedHosts, new URL(c.req.url).host);
  } catch {
    // Malformed request URL; the header-based candidates still apply.
  }
  for (const configured of configuredCorsOrigins()) addHost(allowedHosts, configured);
  return allowedHosts.has(originHost);
}

/** Normalize a host, host:port, or full URL to `hostname[:port]` (default
 * ports dropped) so scheme differences never cause false mismatches. */
function addHost(targets: Set<string>, value: string | undefined): void {
  if (value === undefined) return;
  const trimmed = value.trim();
  if (trimmed === "") return;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(withScheme);
    targets.add(url.port === "" ? url.hostname.toLowerCase() : `${url.hostname.toLowerCase()}:${url.port}`);
  } catch {
    targets.add(trimmed.toLowerCase());
  }
}

function hostOf(origin: string): string | undefined {
  try {
    const url = new URL(origin);
    return url.port === "" ? url.hostname.toLowerCase() : `${url.hostname.toLowerCase()}:${url.port}`;
  } catch {
    return undefined;
  }
}

function configuredCorsOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (raw === undefined || raw.length === 0 || raw === "*") return [];
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

function headerValues(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
