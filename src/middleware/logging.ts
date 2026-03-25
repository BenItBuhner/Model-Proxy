/**
 * Request logging middleware - generates request IDs and tracks timing.
 */
import type { Context, Next } from "hono";
import { randomUUID } from "crypto";

export async function loggingMiddleware(c: Context, next: Next) {
  const requestId = randomUUID();
  const startTime = performance.now();

  // Store on context
  c.set("requestId", requestId);
  c.set("startTime", startTime);

  await next();

  // Add headers
  c.header("X-Request-ID", requestId);

  const elapsed = Math.round(performance.now() - startTime);
  const status = c.res.status;
  const method = c.req.method;
  const path = c.req.path;

  // Skip logging for static/health to reduce noise
  if (!path.startsWith("/health") && !path.startsWith("/setup/static")) {
    console.log(`${method} ${path} ${status} ${elapsed}ms [${requestId.slice(0, 8)}]`);
  }
}
