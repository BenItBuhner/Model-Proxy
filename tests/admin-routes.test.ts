import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { modelConfigLoader } from "../src/config/model-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { createApp } from "../src/server/app.ts";

const tmpRoot = join(tmpdir(), `mp-v2-admin-${process.pid}-${Date.now()}`);

// Pin the config path cache BEFORE createApp() imports anything that would
// touch the default APPDATA path.
mkdirSync(join(tmpRoot, "models"), { recursive: true });
mkdirSync(join(tmpRoot, "providers"), { recursive: true });
setPrimaryConfigDirForTests(tmpRoot);

(modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
(modelConfigLoader as unknown as { pathsArePlainModelDirs: boolean }).pathsArePlainModelDirs = false;
(providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];

beforeAll(() => {
  process.env.CLIENT_API_KEY = "admin-test-key";
  process.env.MODEL_PROXY_ENV_FILE = join(tmpRoot, ".env");
});

afterAll(() => {
  delete process.env.CLIENT_API_KEY;
  delete process.env.MODEL_PROXY_ENV_FILE;
  setPrimaryConfigDirForTests(undefined);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
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
    expect(readFileSync(writeBody.path, "utf8")).toContain("GROQ_API_KEY");

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
    const loginRes = await app.request("/v1/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "admin-test-key" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers.get("set-cookie");
    expect(cookie).toContain("mp_session=");

    const statusRes = await app.request("/v1/admin/auth/status", {
      headers: { cookie: cookie ?? "" },
    });
    expect(statusRes.status).toBe(200);
  });
});
