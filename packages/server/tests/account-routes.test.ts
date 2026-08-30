import { rmWithRetry } from "./support.ts";

import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../src/server/app.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const root = join(tmpdir(), `mp-account-routes-${process.pid}-${Date.now()}`);

beforeEach(() => {
  process.env.CLIENT_API_KEY = "account-admin-key";
  setStorageRootForTests(root);
  closeOperationalDbForTests();
  rmWithRetry(root, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CLIENT_API_KEY;
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  rmWithRetry(root, { recursive: true, force: true });
});

describe("provider account routes", () => {
  test("lets admins share accounts while preventing users from managing them", async () => {
    const app = createApp();
    const owner = await signup(app, "owner@example.com", {
      authorization: "Bearer account-admin-key",
    });

    const settings = await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: jsonHeaders(owner),
      body: JSON.stringify({
        multi_user_enabled: true,
        invite_signup_enabled: true,
      }),
    });
    expect(settings.status).toBe(200);
    const inviteResponse = await app.request("/v1/admin/invites", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({ email: "user@example.com" }),
    });
    const invite = (await inviteResponse.json()) as { token: string };
    const user = await signup(app, "user@example.com", {}, invite.token);

    const created = await app.request("/v1/accounts/token", {
      method: "POST",
      headers: jsonHeaders(owner),
      body: JSON.stringify({
        provider: "openai",
        label: "Shared OpenAI",
        access_token: "never-return-this-token",
        shared: true,
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      account: { id: string; shared: boolean; access_token?: string };
    };
    expect(createdBody.account.shared).toBe(true);
    expect(createdBody.account.access_token).toBeUndefined();

    const listed = await app.request("/v1/accounts", { headers: { cookie: user } });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      accounts: Array<{ id: string; can_use: boolean; can_manage: boolean }>;
    };
    expect(listedBody.accounts).toContainEqual(
      expect.objectContaining({
        id: createdBody.account.id,
        can_use: true,
        can_manage: false,
      }),
    );

    const denied = await app.request(`/v1/accounts/${createdBody.account.id}`, {
      method: "DELETE",
      headers: { cookie: user },
    });
    expect(denied.status).toBe(403);
  });
});

async function signup(
  app: ReturnType<typeof createApp>,
  email: string,
  extraHeaders: Record<string, string> = {},
  inviteToken?: string,
): Promise<string> {
  const response = await app.request("/v1/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      email,
      password: "correct-horse",
      invite_token: inviteToken,
    }),
  });
  expect(response.status).toBe(201);
  return response.headers.get("set-cookie") ?? "";
}

function jsonHeaders(cookie: string): Record<string, string> {
  return { cookie, "content-type": "application/json" };
}
