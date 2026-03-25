/**
 * Client API key authentication middleware.
 */
import type { Context, Next } from "hono";
import { env } from "../core/env.ts";

export async function authMiddleware(c: Context, next: Next) {
  // Skip auth for health endpoints and setup page
  const path = c.req.path;
  if (path.startsWith("/health")) return next();

  const clientKey = env.CLIENT_API_KEY;
  if (!clientKey) {
    if (env.REQUIRE_CLIENT_API_KEY) {
      return c.json({ error: { message: "CLIENT_API_KEY not configured on server", type: "authentication_error" } }, 401);
    }
    return next();
  }

  // Accept Authorization header or X-API-Key
  const authorization = c.req.header("Authorization");
  const xApiKey = c.req.header("X-API-Key");

  if (!authorization && !xApiKey) {
    return c.json({ error: { message: "Missing API key", type: "authentication_error" } }, 401);
  }

  let apiKey = "";
  if (authorization) {
    apiKey = authorization.trim();
    while (apiKey.toLowerCase().startsWith("bearer ")) {
      apiKey = apiKey.slice(7).trim();
    }
  } else {
    apiKey = (xApiKey || "").trim();
  }

  if (apiKey !== clientKey) {
    return c.json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401);
  }

  return next();
}
