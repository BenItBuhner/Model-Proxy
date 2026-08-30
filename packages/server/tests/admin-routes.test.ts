import { rmWithRetry } from "./support.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { createApp } from "../src/server/app.ts";
import {
  recordRequestFinish,
  recordRequestProgress,
  recordRequestStart,
  resetRequestLogForTests,
} from "../src/server/request-log.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const tmpRoot = join(tmpdir(), `mp-v2-admin-${process.pid}-${Date.now()}`);

// Pin the config path cache BEFORE createApp() imports anything that would
// touch the default APPDATA path.
mkdirSync(join(tmpRoot, "models"), { recursive: true });
mkdirSync(join(tmpRoot, "providers"), { recursive: true });
setPrimaryConfigDirForTests(tmpRoot);



beforeAll(() => {
  process.env.CLIENT_API_KEY = "admin-test-key";
  setStorageRootForTests(join(tmpRoot, ".storage"));
});

afterAll(() => {
  delete process.env.CLIENT_API_KEY;
  setPrimaryConfigDirForTests(undefined);
  setStorageRootForTests(undefined);
  try {
    rmWithRetry(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows occasionally holds file handles; safe to ignore in tests.
  }
});

const app = createApp();

function auth(): Record<string, string> {
  return { Authorization: "Bearer admin-test-key" };
}

async function json(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

describe("admin routes", () => {
  test("GET /v1/admin/logs requires auth", async () => {
    const res = await app.request("/v1/admin/logs");
    expect(res.status).toBe(401);
  });

  test("bearer auth lets through", async () => {
    const res = await app.request("/v1/admin/logs", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await json(res)) as Record<string, unknown>;
    expect(Array.isArray(body["records"])).toBe(true);
  });

  test("mutation guard accepts public https origins behind a reverse proxy", async () => {
    const res = await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: {
        ...auth(),
        "content-type": "application/json",
        origin: "https://infer.techlitnow.com",
        host: "infer.techlitnow.com",
        "x-forwarded-host": "infer.techlitnow.com",
        "x-forwarded-proto": "http",
      },
      body: JSON.stringify({ multi_user_enabled: true }),
    });
    expect(res.status).toBe(200);
  });

  test("mutation guard accepts configured CORS origins", async () => {
    const previous = process.env.CORS_ORIGINS;
    process.env.CORS_ORIGINS = "https://infer.techlitnow.com";
    try {
      const res = await app.request("/v1/admin/signup-settings", {
        method: "PUT",
        headers: {
          ...auth(),
          "content-type": "application/json",
          origin: "https://infer.techlitnow.com",
          host: "127.0.0.1:9876",
        },
        body: JSON.stringify({ multi_user_enabled: true }),
      });
      expect(res.status).toBe(200);
    } finally {
      if (previous === undefined) delete process.env.CORS_ORIGINS;
      else process.env.CORS_ORIGINS = previous;
    }
  });

  test("mutation guard rejects unrelated origins", async () => {
    const res = await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: {
        ...auth(),
        "content-type": "application/json",
        origin: "https://evil.example",
        host: "infer.techlitnow.com",
        "x-forwarded-host": "infer.techlitnow.com",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({ multi_user_enabled: true }),
    });
    expect(res.status).toBe(403);
    expect(await json(res)).toEqual({ error: "Cross-origin mutation denied" });
  });

  test("admin logs paginate runtime request history with totals", async () => {
    resetRequestLogForTests();
    rmWithRetry(join(tmpRoot, ".storage"), { recursive: true, force: true });
    for (let i = 0; i < 3; i++) {
      const requestId = `paginated-${i}`;
      recordRequestStart({
        requestId,
        endpoint: "/v1/chat/completions",
        method: "POST",
        requestedModel: "demo-model",
        resolvedModel: "demo-backend",
        resolvedProvider: "demo",
        wireProtocol: "openai",
        isStreaming: false,
        enforceMode: false,
      });
      recordRequestFinish({
        requestId,
        responseStatus: 200,
        responseTimeMs: 10 + i,
      });
    }

    const res = await app.request("/v1/admin/logs?limit=2&offset=1", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await json(res)) as {
      count: number;
      limit: number;
      offset: number;
      total: number;
      total_completed: number;
      active_count: number;
      has_more: boolean;
      records: Array<{ requestId: string }>;
    };
    expect(body.count).toBe(2);
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(1);
    expect(body.total).toBe(3);
    expect(body.total_completed).toBe(3);
    expect(body.active_count).toBe(0);
    expect(body.has_more).toBe(false);
    expect(body.records.map((record) => record.requestId)).toEqual([
      "paginated-1",
      "paginated-0",
    ]);
    resetRequestLogForTests();
    rmWithRetry(join(tmpRoot, ".storage"), { recursive: true, force: true });
  });

  test("admin analytics summarizes persisted requests and log filters", async () => {
    resetRequestLogForTests();
    rmWithRetry(join(tmpRoot, ".storage"), { recursive: true, force: true });
    recordRequestStart({
      requestId: "analytics-route-1",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "demo-model",
      resolvedModel: "demo-backend",
      resolvedProvider: "demo",
      wireProtocol: "openai",
      isStreaming: false,
      enforceMode: false,
      requestBody: { model: "demo-model", messages: [{ role: "user", content: "hello" }] },
      persistCompletions: true,
    });
    recordRequestProgress({
      requestId: "analytics-route-1",
      resolvedProvider: "demo",
      resolvedModel: "demo-backend",
      apiKeyEnvVar: "DEMO_API_KEY",
      keyHint: "...demo",
    });
    recordRequestFinish({
      requestId: "analytics-route-1",
      responseStatus: 200,
      responseTimeMs: 25,
      responseBody: { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    });

    const analyticsRes = await app.request("/v1/admin/analytics", { headers: auth() });
    expect(analyticsRes.status).toBe(200);
    const analytics = (await json(analyticsRes)) as {
      summary: { completedRequests: number; totalTokens: number };
    };
    expect(analytics.summary.completedRequests).toBe(1);
    expect(analytics.summary.totalTokens).toBe(10);

    const logsRes = await app.request("/v1/admin/logs?provider=demo", { headers: auth() });
    const logs = (await json(logsRes)) as { total_completed: number; records: Array<{ requestId: string }> };
    expect(logs.total_completed).toBe(1);
    expect(logs.records[0]?.requestId).toBe("analytics-route-1");

    const timeseriesRes = await app.request("/v1/admin/analytics/timeseries?bucket=day", { headers: auth() });
    expect(timeseriesRes.status).toBe(200);
    const timeseries = (await json(timeseriesRes)) as {
      bucket: string;
      points: Array<{ requests: number; totalTokens: number; promptTokens?: number }>;
    };
    expect(timeseries.bucket).toBe("day");
    expect(timeseries.points.length).toBeGreaterThanOrEqual(1);
    expect(timeseries.points[0]?.requests).toBe(1);
    expect(timeseries.points[0]?.totalTokens).toBe(10);
    expect(timeseries.points[0]?.promptTokens).toBe(7);

    resetRequestLogForTests();
    rmWithRetry(join(tmpRoot, ".storage"), { recursive: true, force: true });
  });

  test("model config create -> get -> patch -> delete lifecycle", async () => {
    const model = {
      logical_name: "demo-model",
      timeout_seconds: 60,
      default_cooldown_seconds: 30,
      model_routings: [
        { provider: "groq", model: "demo-backend", wire_protocol: "openai" },
      ],
    };

    const createRes = await app.request("/v1/admin/config/models/demo-model", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify(model),
    });
    expect(createRes.status).toBe(201);

    const getRes = await app.request("/v1/admin/config/models/demo-model", {
      headers: auth(),
    });
    const getBody = (await json(getRes)) as { model: Record<string, unknown> };
    expect(getBody.model["logical_name"]).toBe("demo-model");

    const patchRes = await app.request("/v1/admin/config/models/demo-model", {
      method: "PATCH",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ timeout_seconds: 120 }),
    });
    expect(patchRes.status).toBe(200);
    const patchBody = (await json(patchRes)) as { model: Record<string, unknown> };
    expect(patchBody.model["timeout_seconds"]).toBe(120);

    const deleteRes = await app.request("/v1/admin/config/models/demo-model", {
      method: "DELETE",
      headers: auth(),
    });
    expect(deleteRes.status).toBe(200);
  });

  test("provider config validation rejects bad schemas", async () => {
    const res = await app.request("/v1/admin/config/providers/broken", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ name: "broken" /* missing endpoints etc */ }),
    });
    expect(res.status).toBe(400);
  });

  test("env read + write round-trip (writes are persisted + applied)", async () => {
    const writeRes = await app.request("/v1/admin/config/env", {
      method: "PUT",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        entries: [
          { key: "CLIENT_API_KEY", value: "admin-test-key" },
          { key: "GROQ_API_KEY", value: "sk-groq-abcd" },
        ],
      }),
    });
    expect(writeRes.status).toBe(200);
    const writeBody = (await json(writeRes)) as { applied: number; path: string };
    expect(writeBody.applied).toBe(2);
    expect(process.env.GROQ_API_KEY).toBe("sk-groq-abcd");
    // Secret values are sealed on disk; only key names appear in plaintext.
    const secretsText = readFileSync(join(writeBody.path, "secrets.json"), "utf8");
    expect(secretsText).toContain("GROQ_API_KEY");
    expect(secretsText).not.toContain("sk-groq-abcd");

    const readRes = await app.request("/v1/admin/config/env", { headers: auth() });
    const readBody = (await json(readRes)) as {
      entries: Array<{ key: string; value: string; masked: boolean }>;
    };
    const groq = readBody.entries.find((e) => e.key === "GROQ_API_KEY");
    expect(groq?.masked).toBe(true);
    expect(groq?.value).not.toBe("sk-groq-abcd");

    const revealRes = await app.request(
      "/v1/admin/config/env?reveal=true",
      { headers: auth() },
    );
    const revealBody = (await json(revealRes)) as {
      entries: Array<{ key: string; value: string }>;
    };
    const groqReveal = revealBody.entries.find((e) => e.key === "GROQ_API_KEY");
    expect(groqReveal?.value).toBe("sk-groq-abcd");
  });

  test("login endpoint issues a session cookie and auth/status recognizes it", async () => {
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "admin-test-key" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get("set-cookie");
    expect(cookie).toContain("mp_session=");

    const statusRes = await app.request("/v1/auth/status", {
      headers: { cookie: cookie ?? "" },
    });
    expect(statusRes.status).toBe(200);
    const statusBody = (await json(statusRes)) as {
      authenticated: boolean;
      header_authenticated?: boolean;
      session_authenticated?: boolean;
    };
    expect(statusBody.authenticated).toBe(true);
    expect(statusBody.header_authenticated).toBe(false);
    expect(statusBody.session_authenticated).toBe(true);
  });

  test("auth/status exposes stale bearer state even when a session cookie is still valid", async () => {
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "admin-test-key" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get("set-cookie");
    expect(cookie).toContain("mp_session=");

    const statusRes = await app.request("/v1/auth/status", {
      headers: {
        cookie: cookie ?? "",
        Authorization: "Bearer stale-key",
      },
    });
    expect(statusRes.status).toBe(200);
    const statusBody = (await json(statusRes)) as {
      authenticated: boolean;
      header_authenticated?: boolean;
      session_authenticated?: boolean;
    };
    expect(statusBody.authenticated).toBe(true);
    expect(statusBody.header_authenticated).toBe(false);
    expect(statusBody.session_authenticated).toBe(true);
  });

  test("openai inference accepts a valid admin session cookie", async () => {
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "admin-test-key" }),
    });
    const cookie = loginRes.headers.get("set-cookie");
    expect(cookie).toContain("mp_session=");

    const res = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        cookie: cookie ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("anthropic inference accepts a valid admin session cookie", async () => {
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "admin-test-key" }),
    });
    const cookie = loginRes.headers.get("set-cookie");
    expect(cookie).toContain("mp_session=");

    const res = await app.request("/v1/messages", {
      method: "POST",
      headers: {
        cookie: cookie ?? "",
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("proxy status requires auth", async () => {
    const res = await app.request("/v1/admin/proxies");
    expect(res.status).toBe(401);
  });

  test("proxy discovery endpoint starts a background job and status exposes the report", async () => {
    const res = await app.request("/v1/admin/proxies/discover", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({
        providers: [],
        candidates: ["http://127.0.0.1:8888"],
        sources: [],
        target_count: 1,
        persist: false,
      }),
    });
    expect(res.status).toBe(202);
    const body = (await json(res)) as { job: { status: string; id: string } };
    expect(body.job.status).toBe("running");

    let statusBody:
      | {
          discovery_job?: {
            status: string;
            report?: { accepted: Array<{ url: string }>; candidatesTested: number };
          };
        }
      | undefined;
    for (let i = 0; i < 20; i++) {
      const statusRes = await app.request("/v1/admin/proxies", { headers: auth() });
      statusBody = await json(statusRes) as typeof statusBody;
      if (statusBody?.discovery_job?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(statusBody?.discovery_job?.status).toBe("completed");
    expect(statusBody?.discovery_job?.report?.accepted[0]?.url).toBe("http://127.0.0.1:8888");
    expect(statusBody?.discovery_job?.report?.candidatesTested).toBe(1);
  });

  test("admin mutations accept forwarded same-origin tunnel requests", async () => {
    const res = await app.request("/v1/admin/signup-settings", {
      method: "PUT",
      headers: {
        ...auth(),
        "content-type": "application/json",
        origin: "https://infer.techlitnow.com",
        "x-forwarded-host": "infer.techlitnow.com",
        "x-forwarded-proto": "https",
      },
      body: JSON.stringify({
        multi_user_enabled: true,
        invite_signup_enabled: true,
        open_signup_enabled: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await json(res)) as { signup: { inviteSignupEnabled: boolean } };
    expect(body.signup.inviteSignupEnabled).toBe(true);
  });

});
