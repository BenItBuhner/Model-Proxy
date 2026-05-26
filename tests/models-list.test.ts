import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { clearUpstreamModelCatalogCache } from "../src/config/upstream-model-catalog.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import {
  SYSTEM_DEFAULT_CONTEXT_WINDOW,
  resolveContextWindow,
} from "../src/routing/context-window.ts";
import { Hono } from "hono";
import { createOpenAIRoutes } from "../src/server/routes/openai.ts";

const tmpRoot = join(tmpdir(), `mp-v2-models-list-${process.pid}-${Date.now()}`);

const originalFetch = globalThis.fetch;
let fetchImpl: typeof fetch = originalFetch;

beforeAll(() => {
  mkdirSync(join(tmpRoot, "models"), { recursive: true });
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  setPrimaryConfigDirForTests(tmpRoot);

  (modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
  (modelConfigLoader as unknown as { pathsArePlainModelDirs: boolean }).pathsArePlainModelDirs =
    false;
  (providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];

  writeFileSync(
    join(tmpRoot, "providers", "groq.json"),
    JSON.stringify({
      name: "groq",
      display_name: "Groq",
      enabled: true,
      api_keys: {
        env_var_patterns: ["GROQ_API_KEY"],
      },
      endpoints: {
        base_url: "https://api.groq.com/openai/v1",
        completions: "/chat/completions",
        streaming: "/chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
      models: {
        "llama-static": {
          context_length: 32768,
        },
      },
    }),
  );

  process.env.CLIENT_API_KEY = "models-list-test-key";
  process.env.GROQ_API_KEY = "test-groq-key";
  process.env.UPSTREAM_MODELS_CACHE_TTL_SECONDS = "3600";
  process.env.UPSTREAM_MODELS_FETCH_TIMEOUT_MS = "3000";

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchImpl(input, init)) as typeof fetch;
});

afterEach(() => {
  clearUpstreamModelCatalogCache();
  modelConfigLoader.clearCache();
  delete process.env["DEFAULT_CONTEXT_WINDOW"];
  fetchImpl = originalFetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLIENT_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.UPSTREAM_MODELS_CACHE_TTL_SECONDS;
  delete process.env.UPSTREAM_MODELS_FETCH_TIMEOUT_MS;
  setPrimaryConfigDirForTests(undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
});

function writeModel(
  name: string,
  body: Record<string, unknown>,
): void {
  writeFileSync(
    join(tmpRoot, "models", `${name}.json`),
    JSON.stringify({ logical_name: name, ...body }),
  );
  modelConfigLoader.reload(name);
}

function auth(): Record<string, string> {
  return { Authorization: "Bearer models-list-test-key" };
}

const app = new Hono();
app.route("/", createOpenAIRoutes());

describe("resolveContextWindow precedence", () => {
  test("uses upstream limit.context when context_window is absent", async () => {
    writeModel("limit-context-model", {
      timeout_seconds: 60,
      default_cooldown_seconds: 60,
      model_routings: [{ provider: "groq", model: "llama-limit" }],
      fallback_model_routings: [],
    });

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "llama-limit", limit: { context: 96000 } }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    const window = await resolveContextWindow("limit-context-model");
    expect(window).toBe(96000);
  });

  test("uses upstream context_window when provider list includes the model", async () => {
    writeModel("upstream-model", {
      timeout_seconds: 60,
      default_cooldown_seconds: 60,
      model_routings: [{ provider: "groq", model: "llama-upstream" }],
      fallback_model_routings: [],
    });

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "llama-upstream", context_window: 65536 }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return originalFetch(input);
    };

    const window = await resolveContextWindow("upstream-model");
    expect(window).toBe(65536);
  });

  test("uses provider.models.context_length when upstream list lacks the model", async () => {
    writeModel("provider-catalog-model", {
      timeout_seconds: 60,
      default_cooldown_seconds: 60,
      model_routings: [{ provider: "groq", model: "llama-static" }],
      fallback_model_routings: [],
    });

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    const window = await resolveContextWindow("provider-catalog-model");
    expect(window).toBe(32768);
  });

  test("uses route context_window when upstream and provider catalog are absent", async () => {
    writeModel("route-override-model", {
      timeout_seconds: 60,
      default_cooldown_seconds: 60,
      model_routings: [
        {
          provider: "groq",
          model: "missing-upstream",
          context_window: 40960,
        },
      ],
      fallback_model_routings: [],
    });

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    const window = await resolveContextWindow("route-override-model");
    expect(window).toBe(40960);
  });

  test("uses DEFAULT_CONTEXT_WINDOW env when no other source applies", async () => {
    writeModel("env-default-model", {
      timeout_seconds: 60,
      default_cooldown_seconds: 60,
      model_routings: [{ provider: "groq", model: "no-metadata" }],
      fallback_model_routings: [],
    });

    process.env["DEFAULT_CONTEXT_WINDOW"] = "200000";

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    const window = await resolveContextWindow("env-default-model");
    expect(window).toBe(200000);
  });

  test("falls back to system preset 128000", async () => {
    writeModel("system-fallback-model", {
      timeout_seconds: 60,
      default_cooldown_seconds: 60,
      model_routings: [{ provider: "groq", model: "no-metadata" }],
      fallback_model_routings: [],
    });

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    const window = await resolveContextWindow("system-fallback-model");
    expect(window).toBe(SYSTEM_DEFAULT_CONTEXT_WINDOW);
  });
});

describe("GET /v1/models", () => {
  test("returns context_window, context_length, and limit.context aliases", async () => {
    writeModel("listed-model", {
      timeout_seconds: 60,
      default_cooldown_seconds: 60,
      context_window: 88000,
      model_routings: [{ provider: "groq", model: "ignored-for-route-override" }],
      fallback_model_routings: [],
    });

    fetchImpl = async (input) => {
      const url = String(input);
      if (url.includes("/models")) {
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input);
    };

    const res = await app.request("/v1/models", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<Record<string, unknown>>;
    };
    const entry = body.data.find((m) => m["id"] === "listed-model");
    expect(entry).toBeDefined();
    expect(entry!["context_window"]).toBe(88000);
    expect(entry!["context_length"]).toBe(88000);
    expect(entry!["limit"]).toEqual({ context: 88000 });
    expect(entry!["owned_by"]).toBe("groq");
  });
});
