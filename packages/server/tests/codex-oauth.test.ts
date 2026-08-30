import { rmWithRetry } from "./support.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  beginCodexBrowserFlow,
  completeCodexBrowserFlow,
  identityFromTokens,
  stopCodexCallbackServerForTests,
} from "../src/accounts/codex-oauth.ts";
import { resolveAccountContext } from "../src/accounts/account-auth.ts";
import { accountRef, createAccount } from "../src/storage/account-store.ts";
import { createUser } from "../src/storage/identity-store.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const root = join(tmpdir(), `mp-codex-oauth-${process.pid}-${Date.now()}`);
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  setStorageRootForTests(root);
  closeOperationalDbForTests();
  rmWithRetry(root, { recursive: true, force: true });
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  stopCodexCallbackServerForTests();
  delete process.env.CODEX_OAUTH_ISSUER;
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  rmWithRetry(root, { recursive: true, force: true });
});

describe("Codex OAuth", () => {
  test("runs independent PKCE state and exchanges the callback into an account", async () => {
    const requests: URLSearchParams[] = [];
    const idToken = jwt({
      sub: "clerk-like-sub",
      email: "codex@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_chatgpt_123",
        chatgpt_plan_type: "pro",
      },
    });
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = new URLSearchParams(await request.text());
        requests.push(body);
        return Response.json({
          access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "refresh-123",
          id_token: idToken,
          expires_in: 3600,
        });
      },
    });
    process.env.CODEX_OAUTH_ISSUER = `http://127.0.0.1:${server.port}`;

    const owner = createUser({
      email: "oauth-owner@example.com",
      password: "correct-horse",
    });
    const first = beginCodexBrowserFlow({
      ownerUserId: owner.id,
      startCallbackServer: false,
    });
    const second = beginCodexBrowserFlow({
      ownerUserId: "user-2",
      startCallbackServer: false,
    });
    expect(first.authorizeUrl).toContain("code_challenge_method=S256");
    expect(first.authorizeUrl).toContain("offline_access");
    expect(first.authorizeUrl).not.toBe(second.authorizeUrl);

    const account = await completeCodexBrowserFlow({
      callbackUrl:
        `http://localhost:1455/auth/callback?code=code-1&state=` +
        encodeURIComponent(new URL(first.authorizeUrl).searchParams.get("state")!),
    });
    expect(account.email).toBe("codex@example.com");
    expect(account.accountId).toBe("acct_chatgpt_123");
    expect(account.plan).toBe("pro");
    expect(account.ownerUserId).toBe(owner.id);
    expect(account.refreshToken).toBe("refresh-123");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.get("grant_type")).toBe("authorization_code");
    expect(requests[0]?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(requests[0]?.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );
  });

  test("extracts account identity from the official namespaced claim", () => {
    const identity = identityFromTokens({
      access_token: jwt({
        email: "person@example.com",
        "https://api.openai.com/auth": {
          chatgpt_account_id: "acct_1",
          chatgpt_plan_type: "plus",
        },
      }),
    });
    expect(identity).toMatchObject({
      email: "person@example.com",
      accountId: "acct_1",
      plan: "plus",
    });
  });

  test("refreshes an expired attached account before routing", async () => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = new URLSearchParams(await request.text());
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("old-refresh");
        return Response.json({
          access_token: "fresh-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
        });
      },
    });
    process.env.CODEX_OAUTH_ISSUER = `http://127.0.0.1:${server.port}`;
    const account = createAccount({
      provider: "codex",
      kind: "oauth",
      accessToken: "expired-access",
      refreshToken: "old-refresh",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      shared: true,
    });
    const resolved = await resolveAccountContext({
      apiKey: accountRef(account.id),
      baseUrlOverride: undefined,
      timeoutSeconds: 5,
      signal: undefined,
    });
    expect(resolved.apiKey).toBe("fresh-access");
    expect(resolved.accountRef).toBe(accountRef(account.id));
  });
});

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "",
  ].join(".");
}
