import { createHash, timingSafeEqual } from "node:crypto";

import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

import { createLogger } from "../observability/logger.ts";
import {
  authenticateApiKey,
  authenticateSessionToken,
  legacyOwnerPrincipal,
  noAuthPrincipal,
  type Principal,
} from "../storage/identity-store.ts";

const log = createLogger("auth");
export const SESSION_COOKIE = "mp_session";

function clientApiKey(): string | undefined {
  const raw = process.env.CLIENT_API_KEY;
  if (raw === undefined || raw.trim() === "") return undefined;
  return raw.trim();
}

export function isAuthConfigured(): boolean {
  return clientApiKey() !== undefined;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Timing-safe comparison for an attacker-supplied key against the configured one. */
export function verifyApiKeyString(presented: string): boolean {
  const expected = clientApiKey();
  if (expected === undefined) return true;
  if (presented.length === 0) return false;
  return constantTimeEquals(presented, expected);
}

function extractPresented(c: Context): string | undefined {
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
  if (authHeader !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match?.[1] !== undefined && match[1].length > 0) {
      return match[1].trim();
    }
  }
  const xApi = c.req.header("x-api-key") ?? c.req.header("X-API-Key");
  if (xApi !== undefined && xApi.length > 0) return xApi.trim();
  return undefined;
}

export function verifyClientApiKey(c: Context): boolean {
  const expected = clientApiKey();
  if (expected === undefined) {
    // Auth disabled entirely - only for local dev.
    log.warn("CLIENT_API_KEY is unset; auth is DISABLED");
    return true;
  }
  const presented = extractPresented(c);
  if (presented === undefined) return false;
  return constantTimeEquals(presented, expected);
}

export function authenticateRequest(c: Context, options: { allowSession?: boolean } = {}): Principal | undefined {
  const expected = clientApiKey();
  if (options.allowSession) {
    const sessionPrincipal = authenticateSession(c);
    if (sessionPrincipal !== undefined) return sessionPrincipal;
  }

  const presented = extractPresented(c);
  const userPrincipal = authenticateApiKey(presented);
  if (userPrincipal !== undefined) return userPrincipal;

  if (expected === undefined) {
    log.warn("CLIENT_API_KEY is unset; auth is DISABLED");
    return noAuthPrincipal();
  }
  if (
    expected !== undefined &&
    presented !== undefined &&
    constantTimeEquals(presented, expected)
  ) {
    return legacyOwnerPrincipal();
  }
  return undefined;
}

export async function authenticateRequestAsync(
  c: Context,
  options: { allowSession?: boolean } = {},
): Promise<Principal | undefined> {
  return authenticateRequest(c, options);
}

function authenticateSession(c: Context): Principal | undefined {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie === undefined) return undefined;
  const legacyToken = clientApiKeyFingerprint();
  if (legacyToken !== undefined && cookie === legacyToken) return legacyOwnerPrincipal();
  return authenticateSessionToken(cookie);
}

export function currentSessionToken(): string {
  return clientApiKeyFingerprint() ?? "no-auth";
}

export function isSessionValid(c: Context): boolean {
  if (!isAuthConfigured()) return true;
  return authenticateSession(c) !== undefined;
}

export function principal(c: Context): Principal | undefined {
  return c.get("principal");
}

export function requireAuth(
  options: { allowSession?: boolean } = {},
): MiddlewareHandler {
  return async (c, next) => {
    const authenticated = await authenticateRequestAsync(c, options);
    if (authenticated === undefined) {
      return c.json(
        {
          error: {
            message: "Unauthorized: missing or invalid API key",
            type: "authentication_error",
          },
        },
        401,
      );
    }
    c.set("principal", authenticated);
    await next();
    return;
  };
}

/**
 * Hash of the configured key for use in structured logs and session cookies.
 * The raw key never leaves memory; only a short SHA-256 prefix is compared.
 */
export function clientApiKeyFingerprint(): string | undefined {
  const key = clientApiKey();
  if (key === undefined) return undefined;
  const hash = createHash("sha256").update(key).digest("hex");
  return hash.slice(0, 16);
}
