import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resetClerkCachesForTests } from "../src/server/clerk-auth.ts";
import { createApp } from "../src/server/app.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const root = join(tmpdir(), `mp-clerk-${process.pid}-${Date.now()}`);
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  process.env.CLIENT_API_KEY = "legacy-key";
  process.env.CLERK_OWNER_EMAILS = "owner@clerk.test";
  setStorageRootForTests(root);
  closeOperationalDbForTests();
  resetClerkCachesForTests();
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  delete process.env.CLIENT_API_KEY;
  delete process.env.CLERK_ISSUER_URL;
  delete process.env.CLERK_OWNER_EMAILS;
  delete process.env.CLERK_AUTHORIZED_PARTIES;
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  resetClerkCachesForTests();
  rmSync(root, { recursive: true, force: true });
});

describe("Clerk authentication", () => {
  test("verifies RS256 JWKS tokens and auto-provisions the mapped user", async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey & {
      kid?: string;
    };
    publicJwk.kid = "test-key";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/.well-known/jwks.json") {
          return Response.json({ keys: [publicJwk] });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const issuer = `http://127.0.0.1:${server.port}`;
    process.env.CLERK_ISSUER_URL = issuer;
    process.env.CLERK_AUTHORIZED_PARTIES = "https://proxy.example.com";
    delete process.env.CLIENT_API_KEY;
    const token = await signJwt(pair.privateKey, {
      sub: "user_clerk_123",
      iss: issuer,
      azp: "https://proxy.example.com",
      email: "owner@clerk.test",
      exp: Math.floor(Date.now() / 1_000) + 300,
    });

    const app = createApp();
    const forgedLegacySession = await app.request("/v1/auth/me", {
      headers: { cookie: "mp_session=no-auth" },
    });
    expect(forgedLegacySession.status).toBe(401);
    const response = await app.request("/v1/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      principal: {
        email: string;
        role: string;
        authMethod: string;
        ownerBypass: boolean;
      };
    };
    expect(body.principal).toMatchObject({
      email: "owner@clerk.test",
      role: "owner",
      authMethod: "clerk",
      ownerBypass: true,
    });

    // The external identity is stable; a second request maps to the same user.
    const second = await app.request("/v1/auth/me", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(second.status).toBe(200);
  });
});

async function signJwt(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
): Promise<string> {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    Buffer.from(`${header}.${body}`),
  );
  return `${header}.${body}.${Buffer.from(signature).toString("base64url")}`;
}
