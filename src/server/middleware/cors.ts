import type { MiddlewareHandler } from "hono";

function parseOrigins(): string[] | "*" {
  const raw = process.env.CORS_ORIGINS?.trim();
  if (raw === undefined || raw.length === 0 || raw === "*") return "*";
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Minimal CORS middleware. Same behavior as FastAPI's CORSMiddleware config.
 */
export function corsMiddleware(): MiddlewareHandler {
  const allowed = parseOrigins();

  return async (c, next) => {
    const origin = c.req.header("origin");

    if (origin !== undefined) {
      let allowHeader: string | undefined;
      if (allowed === "*") {
        allowHeader = "*";
      } else if (allowed.includes(origin)) {
        allowHeader = origin;
      }
      if (allowHeader !== undefined) {
        c.header("Access-Control-Allow-Origin", allowHeader);
        c.header("Vary", "Origin");
        c.header("Access-Control-Allow-Credentials", "true");
      }
    }

    if (c.req.method === "OPTIONS") {
      const reqHeaders = c.req.header("access-control-request-headers");
      c.header(
        "Access-Control-Allow-Methods",
        "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      );
      c.header(
        "Access-Control-Allow-Headers",
        reqHeaders ?? "Authorization, Content-Type, X-API-Key, X-Request-ID, X-Enforce-Tool-Call",
      );
      c.header("Access-Control-Max-Age", "600");
      return c.body(null, 204);
    }

    await next();
    return;
  };
}
