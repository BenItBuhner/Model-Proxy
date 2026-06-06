import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { modelConfigLoader } from "../src/config/model-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { eventSink } from "../src/observability/event-sink.ts";
import type {
  AnthropicCallArgs,
  BaseProvider,
  OpenAICallArgs,
  ProviderCallContext,
} from "../src/providers/base.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { resetProxyState } from "../src/providers/egress-proxy-manager.ts";
import { ProviderAPIError } from "../src/providers/errors.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import { createApp } from "../src/server/app.ts";

const tmpRoot = join(tmpdir(), `mp-events-${process.pid}-${Date.now()}`);

mkdirSync(join(tmpRoot, "models"), { recursive: true });
mkdirSync(join(tmpRoot, "providers"), { recursive: true });
setPrimaryConfigDirForTests(tmpRoot);

(modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
(modelConfigLoader as unknown as { pathsArePlainModelDirs: boolean }).pathsArePlainModelDirs = false;
(providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];

class FakeProvider implements BaseProvider {
  readonly providerName = "fakee";
  readonly wireProtocol = "openai" as const;
  readonly config = {} as BaseProvider["config"];

  static responses: Array<Record<string, unknown> | Error> = [];
  static calls: Array<{ args: OpenAICallArgs; ctx: ProviderCallContext }> = [];

  async callOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    FakeProvider.calls.push({ args, ctx });
    const next = FakeProvider.responses.shift();
    if (next === undefined) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return next;
  }

  async callAnthropic(
    _args: AnthropicCallArgs,
    _ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }
}

beforeAll(() => {
  process.env.CLIENT_API_KEY = "events-test";
  process.env.FAKEE_API_KEY = "fakee-key-aaaa";
  process.env.FAKEE_PROXY_API_KEY = "fakee-proxy-key-zzzz";
  process.env.FAKEE_PROXY_EGRESS_PROXY_1 = "http://proxy-one:8080";
  process.env.FAKEE_PROXY_EGRESS_PROXY_2 = "http://user:pass@proxy-two:8080";

  writeFileSync(
    join(tmpRoot, "providers", "fakee.json"),
    JSON.stringify({
      name: "fakee",
      display_name: "Fake E",
      enabled: true,
      api_keys: { env_var_patterns: ["FAKEE_API_KEY"] },
      endpoints: {
        base_url: "https://fakee.local/v1",
        completions: "/chat/completions",
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
    join(tmpRoot, "providers", "fakee-proxy.json"),
    JSON.stringify({
      name: "fakee-proxy",
      display_name: "Fake E Proxy",
      enabled: true,
      api_keys: { env_var_patterns: ["FAKEE_PROXY_API_KEY"] },
      endpoints: {
        base_url: "https://fakee-proxy.local/v1",
        completions: "/chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
      egress_proxies: {
        enabled: true,
        env_var_patterns: ["FAKEE_PROXY_EGRESS_PROXY_{INDEX}"],
        cooldown_seconds: 0,
      },
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fakee-model.json"),
    JSON.stringify({
      logical_name: "fakee-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fakee", model: "fakee-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fakee-proxy-model.json"),
    JSON.stringify({
      logical_name: "fakee-proxy-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fakee-proxy", model: "fakee-proxy-backend", wire_protocol: "openai" },
      ],
    }),
  );

  providerRegistry.registerProvider("fakee", () => new FakeProvider());
  providerRegistry.registerProvider("fakee-proxy", () => new FakeProvider());
});

afterAll(() => {
  providerRegistry.unregisterProvider("fakee");
  providerRegistry.unregisterProvider("fakee-proxy");
  resetKeyState("fakee");
  resetKeyState("fakee-proxy");
  resetProxyState("fakee-proxy");
  delete process.env.CLIENT_API_KEY;
  delete process.env.FAKEE_API_KEY;
  delete process.env.FAKEE_PROXY_API_KEY;
  delete process.env.FAKEE_PROXY_EGRESS_PROXY_1;
  delete process.env.FAKEE_PROXY_EGRESS_PROXY_2;
  setPrimaryConfigDirForTests(undefined);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore windows file-lock issues
  }
});

afterEach(() => {
  FakeProvider.responses = [];
  FakeProvider.calls = [];
  eventSink._resetForTests();
});

const app = createApp();
const auth = { Authorization: "Bearer events-test" } as Record<string, string>;

describe("request-scoped event tracing", () => {
  test("snapshot endpoint returns the full timeline for a completed request", async () => {
    FakeProvider.responses = [
      {
        id: "c-1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];

    const id = "test-req-aaa";
    const inferRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify({
        model: "fakee-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(inferRes.status).toBe(200);

    const snapRes = await app.request(
      `/v1/admin/events/${encodeURIComponent(id)}`,
      { headers: auth },
    );
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      requestId: string;
      finished: boolean;
      events: Array<{
        type: string;
        keyHint?: string;
        apiKeyEnvVar?: string;
      }>;
    };
    expect(snap.requestId).toBe(id);
    expect(snap.finished).toBe(true);
    const types = snap.events.map((e) => e.type);
    expect(types[0]).toBe("request.started");
    expect(types).toContain("route.attempted");
    expect(types).toContain("route.succeeded");
    expect(types[types.length - 1]).toBe("request.finished");
    const routeAttempt = snap.events.find((e) => e.type === "route.attempted");
    expect(routeAttempt?.keyHint).toBe("...aaaa");
    expect(routeAttempt?.apiKeyEnvVar).toBe("(auto)");
  });

  test("snapshot 404s for unknown requestId", async () => {
    const res = await app.request("/v1/admin/events/never-existed", {
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  test("snapshot requires auth", async () => {
    const res = await app.request("/v1/admin/events/anything");
    expect(res.status).toBe(401);
  });

  test("route traces expose masked proxy rotation metadata", async () => {
    const savedSharedProxyEnv = Object.entries(process.env).filter(([key]) =>
      key.startsWith("MODEL_PROXY_EGRESS_PROXY"),
    );
    for (const [key] of savedSharedProxyEnv) delete process.env[key];
    FakeProvider.responses = [
      new ProviderAPIError("429 first", 429, {
        provider: "fakee-proxy",
        body: "RateLimitError",
      }),
      {
        id: "c-2",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fakee-proxy");
    resetProxyState("fakee-proxy");

    try {
      const id = "test-req-proxy";
      const inferRes = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "x-request-id": id },
        body: JSON.stringify({
          model: "fakee-proxy-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(inferRes.status).toBe(200);

      const snapRes = await app.request(
        `/v1/admin/events/${encodeURIComponent(id)}`,
        { headers: auth },
      );
      expect(snapRes.status).toBe(200);
      const snap = (await snapRes.json()) as {
        events: Array<{
          type: string;
          egressProxyEnvVar?: string;
          egressProxyHint?: string;
        }>;
      };
      const attempts = snap.events.filter((event) => event.type === "route.attempted");
      expect(attempts).toMatchObject([
        {
          egressProxyEnvVar: "FAKEE_PROXY_EGRESS_PROXY_1",
          egressProxyHint: "proxy-one:8080",
        },
        {
          egressProxyEnvVar: "FAKEE_PROXY_EGRESS_PROXY_2",
          egressProxyHint: "proxy-two:8080",
        },
      ]);
      expect(snap.events.find((event) => event.type === "proxy.cooldown")).toMatchObject({
        egressProxyEnvVar: "FAKEE_PROXY_EGRESS_PROXY_1",
        egressProxyHint: "proxy-one:8080",
      });
    } finally {
      for (const [key] of Object.entries(process.env)) {
        if (key.startsWith("MODEL_PROXY_EGRESS_PROXY")) delete process.env[key];
      }
      for (const [key, value] of savedSharedProxyEnv) process.env[key] = value;
    }
  });
});
