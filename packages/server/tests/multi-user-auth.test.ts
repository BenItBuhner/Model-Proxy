import { rmWithRetry } from "./support.ts";

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createApp } from "../src/server/app.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import {
  recordRequestFinish,
  recordRequestStart,
  resetRequestLogForTests,
} from "../src/server/request-log.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";

const tmpRoot = join(tmpdir(), `mp-users-${process.pid}-${Date.now()}`);

beforeEach(() => {
  process.env.CLIENT_API_KEY = "multi-user-admin-key";
  setStorageRootForTests(tmpRoot);
  setPrimaryConfigDirForTests(tmpRoot);
  closeOperationalDbForTests();
  rmWithRetry(tmpRoot, { recursive: true, force: true });
  mkdirSync(join(tmpRoot, "models"), { recursive: true });
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  writeFileSync(
    join(tmpRoot, "providers", "env-test.json"),
    JSON.stringify({
      name: "env-test",
      display_name: "Env Test",
      enabled: true,
      api_keys: { env_var_patterns: ["ENV_TEST_API_KEY"] },
      endpoints: {
        base_url: "https://env-test.invalid/v1",
        completions: "/chat/completions",
        streaming: "/chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
    }),
  );
  writeFileSync(
    join(tmpRoot, "models", "env-test-model.json"),
    JSON.stringify({
      logical_name: "env-test-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 1,
      model_routings: [{ provider: "env-test", model: "env-test-upstream" }],
      fallback_model_routings: [],
    }),
  );
  providerConfigLoader.clearCache();
  modelConfigLoader.clearCache();
});

afterEach(() => {
  delete process.env.CLIENT_API_KEY;
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  setPrimaryConfigDirForTests(undefined);
  providerConfigLoader.clearCache();
  modelConfigLoader.clearCache();
  rmWithRetry(tmpRoot, { recursive: true, force: true });
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

  test("revokes user API keys so they can no longer authenticate", async () => {
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
      body: JSON.stringify({ label: "ephemeral" }),
    });
    expect(keyRes.status).toBe(201);
    const keyBody = await keyRes.json() as { api_key: { id: string; key: string } };

    const list = await app.request("/v1/user/api-keys", { headers: { cookie } });
    expect(list.status).toBe(200);
    const listBody = await list.json() as { keys: Array<{ id: string; status: string }> };
    expect(listBody.keys).toHaveLength(1);
    expect(listBody.keys[0]!.status).toBe("active");

    const del = await app.request(`/v1/user/api-keys/${keyBody.api_key.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(200);

    const me = await app.request("/v1/auth/me", {
      headers: { authorization: `Bearer ${keyBody.api_key.key}` },
    });
    expect(me.status).toBe(401);

    const after = await app.request("/v1/user/api-keys", { headers: { cookie } });
    const afterBody = await after.json() as { keys: Array<{ status: string }> };
    expect(afterBody.keys).toHaveLength(0);

    const again = await app.request(`/v1/user/api-keys/${keyBody.api_key.id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(again.status).toBe(404);
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

  test("GET /v1/user/logs scopes request history to the caller's account", async () => {
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

    const me = await app.request("/v1/auth/me", { headers: { cookie: userCookie } });
    const meBody = await me.json() as { principal: { userId?: string } };
    const userId = meBody.principal.userId;
    expect(userId).toBeDefined();

    resetRequestLogForTests();
    for (let i = 0; i < 2; i++) {
      recordRequestStart({
        requestId: `user-log-${i}`,
        endpoint: "/v1/chat/completions",
        method: "POST",
        requestedModel: "demo-model",
        resolvedModel: "demo-backend",
        resolvedProvider: "demo",
        wireProtocol: "openai",
        userId,
        isStreaming: false,
        enforceMode: false,
      });
      recordRequestFinish({ requestId: `user-log-${i}`, responseStatus: 200, responseTimeMs: 10 + i });
    }
    recordRequestStart({
      requestId: "user-log-running",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo-model",
      resolvedModel: "demo-backend",
      resolvedProvider: "demo",
      wireProtocol: "openai",
      userId,
      isStreaming: false,
      enforceMode: false,
    });
    recordRequestStart({
      requestId: "other-user-log",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo-model",
      resolvedModel: "demo-backend",
      resolvedProvider: "demo",
      wireProtocol: "openai",
      userId: "someone-else",
      isStreaming: false,
      enforceMode: false,
    });
    recordRequestFinish({ requestId: "other-user-log", responseStatus: 200, responseTimeMs: 5 });

    const logs = await app.request("/v1/user/logs?limit=1000", { headers: { cookie: userCookie } });
    expect(logs.status).toBe(200);
    const logsBody = await logs.json() as {
      total: number;
      total_completed: number;
      active_count: number;
      has_more: boolean;
      filters_applied: { userId?: string };
      records: Array<{ requestId: string; userId: string | undefined }>;
    };
    expect(logsBody.total).toBe(3);
    expect(logsBody.total_completed).toBe(2);
    expect(logsBody.active_count).toBe(1);
    expect(logsBody.has_more).toBe(false);
    expect(logsBody.filters_applied.userId).toBe(userId);
    expect(logsBody.records).toHaveLength(3);
    for (const record of logsBody.records) {
      expect(record.userId).toBe(userId);
      expect(record.requestId).not.toBe("other-user-log");
    }

    const unauthorized = await app.request("/v1/user/logs");
    expect(unauthorized.status).toBe(401);
  });

  test("users with no model entitlements can list and use models", async () => {
    const app = createApp();
    const ownerSignup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer multi-user-admin-key",
      },
      body: JSON.stringify({ email: "owner2@example.com", password: "correct-horse" }),
    });
    const ownerCookie = ownerSignup.headers.get("set-cookie") ?? "";

    await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({
        multi_user_enabled: true,
        invite_signup_enabled: true,
        open_signup_enabled: false,
      }),
    });

    const invite = await app.request("/v1/admin/invites", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ email: "unrestricted@example.com" }),
    });
    const inviteBody = await invite.json() as { token: string };

    const userSignup = await app.request("/v1/auth/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "unrestricted@example.com",
        password: "correct-horse",
        invite_token: inviteBody.token,
      }),
    });
    expect(userSignup.status).toBe(201);
    const userBody = await userSignup.json() as { user: { id: string } };
    const userCookie = userSignup.headers.get("set-cookie") ?? "";

    await app.request(`/v1/admin/users/${userBody.user.id}/entitlements`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: ownerCookie },
      body: JSON.stringify({ entitlements: [] }),
    });

    const models = await app.request("/v1/models", { headers: { cookie: userCookie } });
    expect(models.status).toBe(200);
    const modelsBody = await models.json() as { data: Array<{ id: string }> };
    expect(modelsBody.data.length).toBeGreaterThan(0);
  });
});
