import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../src/server/app.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const tmpRoot = join(tmpdir(), `mp-users-${process.pid}-${Date.now()}`);

beforeEach(() => {
  process.env.CLIENT_API_KEY = "multi-user-admin-key";
  setStorageRootForTests(tmpRoot);
  closeOperationalDbForTests();
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.CLIENT_API_KEY;
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("multi-user auth", () => {
  test("bootstraps an owner account and authenticates generated user API keys", async () => {
    const app = createApp();
    const signup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer multi-user-admin-key",
      },
      body: JSON.stringify({ email: "owner@example.com", password: "correct-horse" }),
    });
    expect(signup.status).toBe(201);
    const cookie = signup.headers.get("set-cookie") ?? "";

    const keyRes = await app.request("/v1/user/api-keys", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ label: "test key" }),
    });
    expect(keyRes.status).toBe(201);
    const keyBody = await keyRes.json() as { api_key: { key: string } };

    const me = await app.request("/v1/auth/me", {
      headers: { authorization: `Bearer ${keyBody.api_key.key}` },
    });
    expect(me.status).toBe(200);
    const meBody = await me.json() as { principal: { email: string; role: string } };
    expect(meBody.principal.email).toBe("owner@example.com");
    expect(meBody.principal.role).toBe("owner");
  });

  test("supports invite-only signup with one-time tokens", async () => {
    const app = createApp();
    const ownerSignup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer multi-user-admin-key",
      },
      body: JSON.stringify({ email: "owner@example.com", password: "correct-horse" }),
    });
    const ownerCookie = ownerSignup.headers.get("set-cookie") ?? "";

    const settings = await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        multi_user_enabled: true,
        invite_signup_enabled: true,
        open_signup_enabled: false,
      }),
    });
    expect(settings.status).toBe(200);

    const invite = await app.request("/v1/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ email: "user@example.com" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json() as { token: string };

    const userSignup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "user@example.com",
        password: "correct-horse",
        invite_token: inviteBody.token,
      }),
    });
    expect(userSignup.status).toBe(201);

    const reused = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "second@example.com",
        password: "correct-horse",
        invite_token: inviteBody.token,
      }),
    });
    expect(reused.status).toBe(403);
  });

  test("creates a normal user, not an owner, from a one-time invite link even when no owner row exists", async () => {
    const app = createApp();
    const settings = await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer multi-user-admin-key",
      },
      body: JSON.stringify({
        multi_user_enabled: true,
        invite_signup_enabled: true,
        open_signup_enabled: false,
      }),
    });
    expect(settings.status).toBe(200);

    const invite = await app.request("/v1/admin/invites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer multi-user-admin-key",
      },
      body: JSON.stringify({ email: "user-from-invite@example.com" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json() as { token: string };

    const signup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "user-from-invite@example.com",
        password: "correct-horse",
        invite_token: inviteBody.token,
      }),
    });
    expect(signup.status).toBe(201);
    const signupBody = await signup.json() as {
      user: { role: string };
      bootstrap_owner: boolean;
    };
    expect(signupBody.bootstrap_owner).toBe(false);
    expect(signupBody.user.role).toBe("user");
  });

  test("normal users can read their own client limits and analytics without admin access", async () => {
    const app = createApp();
    const ownerSignup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer multi-user-admin-key",
      },
      body: JSON.stringify({ email: "owner@example.com", password: "correct-horse" }),
    });
    const ownerCookie = ownerSignup.headers.get("set-cookie") ?? "";

    const settings = await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        multi_user_enabled: true,
        invite_signup_enabled: true,
        open_signup_enabled: false,
        default_limits: { requests_per_day: 25 },
      }),
    });
    expect(settings.status).toBe(200);

    const invite = await app.request("/v1/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ email: "client@example.com" }),
    });
    expect(invite.status).toBe(201);
    const inviteBody = await invite.json() as { token: string };

    const userSignup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "client@example.com",
        password: "correct-horse",
        invite_token: inviteBody.token,
      }),
    });
    expect(userSignup.status).toBe(201);
    const userCookie = userSignup.headers.get("set-cookie") ?? "";

    const limits = await app.request("/v1/user/limits", { headers: { cookie: userCookie } });
    expect(limits.status).toBe(200);
    const limitsBody = await limits.json() as { limits: { requestsPerDay?: number } };
    expect(limitsBody.limits.requestsPerDay).toBe(25);

    const analytics = await app.request("/v1/user/analytics", { headers: { cookie: userCookie } });
    expect(analytics.status).toBe(200);
    const analyticsBody = await analytics.json() as { summary: { totalRequests: number } };
    expect(analyticsBody.summary.totalRequests).toBe(0);

    const timeseries = await app.request("/v1/user/analytics/timeseries?bucket=day", {
      headers: { cookie: userCookie },
    });
    expect(timeseries.status).toBe(200);
    const timeseriesBody = await timeseries.json() as {
      bucket: string;
      points: Array<{ totalTokens: number }>;
    };
    expect(timeseriesBody.bucket).toBe("day");
    expect(Array.isArray(timeseriesBody.points)).toBe(true);
    expect(timeseriesBody.points).toHaveLength(0);

    const adminUsers = await app.request("/v1/admin/users", { headers: { cookie: userCookie } });
    expect(adminUsers.status).toBe(403);
  });
});
