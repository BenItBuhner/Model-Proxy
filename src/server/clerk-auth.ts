import type { Context } from "hono";
import { getCookie } from "hono/cookie";

import {
  upsertExternalIdentity,
  type Principal,
  type UserRole,
} from "../storage/identity-store.ts";

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface ClerkClaims {
  sub?: string;
  iss?: string;
  azp?: string;
  exp?: number;
  nbf?: number;
  email?: string;
  primary_email_address?: string;
}

interface JwksResponse {
  keys?: Array<JsonWebKey & { kid?: string }>;
}

const JWKS_TTL_MS = 5 * 60 * 1000;
let jwksCache:
  | { issuer: string; expiresAt: number; keys: Map<string, CryptoKey> }
  | undefined;
const emailCache = new Map<string, { email: string; expiresAt: number }>();

export function isClerkConfigured(): boolean {
  return clerkIssuer() !== undefined;
}

export async function authenticateClerkRequest(c: Context): Promise<Principal | undefined> {
  const token = extractClerkToken(c);
  if (token === undefined) return undefined;
  return authenticateClerkToken(token);
}

export async function authenticateClerkToken(token: string): Promise<Principal | undefined> {
  const issuer = clerkIssuer();
  if (issuer === undefined || token.split(".").length !== 3) return undefined;
  const claims = await verifyClerkToken(token, issuer);
  if (claims === undefined || claims.sub === undefined) return undefined;
  const email = await clerkUserEmail(claims);
  if (email === undefined) {
    throw new Error(
      "Clerk token is valid but no email is available; configure CLERK_SECRET_KEY or an email session claim",
    );
  }
  return upsertExternalIdentity({
    provider: "clerk",
    externalId: claims.sub,
    email,
    role: roleForEmail(email),
  });
}

export async function verifyClerkToken(
  token: string,
  expectedIssuer = clerkIssuer(),
): Promise<ClerkClaims | undefined> {
  if (expectedIssuer === undefined) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  ) {
    return undefined;
  }
  let header: JwtHeader;
  let claims: ClerkClaims;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as JwtHeader;
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as ClerkClaims;
  } catch {
    return undefined;
  }
  if (header.alg !== "RS256" || header.kid === undefined) return undefined;
  if (claims.iss?.replace(/\/+$/, "") !== expectedIssuer.replace(/\/+$/, "")) return undefined;
  const now = Math.floor(Date.now() / 1_000);
  if (typeof claims.exp !== "number" || claims.exp <= now) return undefined;
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) return undefined;
  if (!allowedAuthorizedParty(claims.azp)) return undefined;

  const key = (await clerkKeys(expectedIssuer)).get(header.kid);
  if (key === undefined) return undefined;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    Buffer.from(encodedSignature, "base64url"),
    Buffer.from(`${encodedHeader}.${encodedPayload}`, "utf8"),
  );
  return valid ? claims : undefined;
}

function extractClerkToken(c: Context): string | undefined {
  const authorization = c.req.header("authorization") ?? c.req.header("Authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer !== undefined && bearer.split(".").length === 3) return bearer;
  return getCookie(c, "__session");
}

async function clerkKeys(issuer: string): Promise<Map<string, CryptoKey>> {
  if (
    jwksCache !== undefined &&
    jwksCache.issuer === issuer &&
    jwksCache.expiresAt > Date.now()
  ) {
    return jwksCache.keys;
  }
  const url =
    process.env["CLERK_JWKS_URL"]?.trim() ||
    `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Unable to load Clerk JWKS (${response.status})`);
  const body = (await response.json()) as JwksResponse;
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (typeof jwk.kid !== "string" || jwk.kty !== "RSA") continue;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    keys.set(jwk.kid, key);
  }
  jwksCache = { issuer, expiresAt: Date.now() + JWKS_TTL_MS, keys };
  return keys;
}

function clerkIssuer(): string | undefined {
  const value = process.env["CLERK_ISSUER_URL"]?.trim();
  return value !== undefined && value.length > 0 ? value.replace(/\/+$/, "") : undefined;
}

function allowedAuthorizedParty(azp: string | undefined): boolean {
  const configured = process.env["CLERK_AUTHORIZED_PARTIES"]?.trim();
  if (configured === undefined || configured.length === 0) return true;
  if (azp === undefined) return false;
  return configured.split(",").map((value) => value.trim()).includes(azp);
}

async function clerkUserEmail(claims: ClerkClaims): Promise<string | undefined> {
  const claimEmail = claims.email ?? claims.primary_email_address;
  if (claimEmail !== undefined && claimEmail.includes("@")) return claimEmail.toLowerCase();
  if (claims.sub === undefined) return undefined;
  const cached = emailCache.get(claims.sub);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.email;
  const secret = process.env["CLERK_SECRET_KEY"]?.trim();
  if (secret === undefined || secret.length === 0) return undefined;
  const response = await fetch(
    `https://api.clerk.com/v1/users/${encodeURIComponent(claims.sub)}`,
    { headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" } },
  );
  if (!response.ok) throw new Error(`Unable to load Clerk user (${response.status})`);
  const user = (await response.json()) as {
    primary_email_address_id?: unknown;
    email_addresses?: Array<{ id?: unknown; email_address?: unknown }>;
  };
  const primary = user.email_addresses?.find(
    (entry) => entry.id === user.primary_email_address_id,
  );
  const value =
    typeof primary?.email_address === "string"
      ? primary.email_address
      : user.email_addresses?.find((entry) => typeof entry.email_address === "string")
          ?.email_address;
  if (typeof value !== "string") return undefined;
  const email = value.toLowerCase();
  emailCache.set(claims.sub, { email, expiresAt: Date.now() + 10 * 60 * 1000 });
  return email;
}

function roleForEmail(email: string): UserRole {
  if (emailList("CLERK_OWNER_EMAILS").has(email.toLowerCase())) return "owner";
  if (emailList("CLERK_ADMIN_EMAILS").has(email.toLowerCase())) return "admin";
  return "user";
}

function emailList(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value.length > 0),
  );
}

export function resetClerkCachesForTests(): void {
  jwksCache = undefined;
  emailCache.clear();
}
