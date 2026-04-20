import { randomUUID } from "node:crypto";

import type { MiddlewareHandler } from "hono";

/**
 * Attaches a request id + start time to each incoming request. Mirrors the
 * Python `LoggingMiddleware`.
 */
export function requestContextMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const inboundId = c.req.header("x-request-id");
    const requestId =
      inboundId !== undefined && inboundId.length > 0 ? inboundId : randomUUID();
    const startedAt = performance.now();

    c.set("requestId", requestId);
    c.set("startedAt", startedAt);

    c.header("X-Request-ID", requestId);

    await next();
  };
}

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
    startedAt: number;
  }
}
