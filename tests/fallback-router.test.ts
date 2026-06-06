import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type {
  AnthropicCallArgs,
  BaseProvider,
  OpenAICallArgs,
  ProviderCallContext,
} from "../src/providers/base.ts";
import { ProviderAPIError } from "../src/providers/errors.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { resetProxyState } from "../src/providers/egress-proxy-manager.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { FallbackRouter } from "../src/routing/fallback.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";

const tmpRoot = join(tmpdir(), `mp-v2-routing-${process.pid}-${Date.now()}`);

// Replace the singleton loader's config dir at module-scope by a fresh loader
// pointing at our sandbox (via monkey-patched internals).
(modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
(modelConfigLoader as unknown as { pathsArePlainModelDirs: boolean }).pathsArePlainModelDirs = false;
(providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];

class FakeProvider implements BaseProvider {
  readonly providerName = "fake";
  readonly wireProtocol = "openai" as const;
  readonly config = {} as BaseProvider["config"];

  static calls: Array<{ args: OpenAICallArgs; ctx: ProviderCallContext }> = [];
  static responses: Array<Record<string, unknown> | Error> = [];

  async callOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    FakeProvider.calls.push({ args, ctx });
    const next = FakeProvider.responses.shift();
    if (next === undefined) {
      throw new Error("No response queued");
    }
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
  mkdirSync(join(tmpRoot, "models"), { recursive: true });
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });

  writeFileSync(
    join(tmpRoot, "providers", "fake.json"),
    JSON.stringify({
      name: "fake",
      display_name: "Fake Provider",
      enabled: true,
      api_keys: { env_var_patterns: ["FAKE_API_KEY", "FAKE_API_KEY_{INDEX}"] },
      endpoints: {
        base_url: "https://fake.local/v1",
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
    join(tmpRoot, "models", "fake-model.json"),
    JSON.stringify({
      logical_name: "fake-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fake", model: "fake-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "providers", "fake-proxy.json"),
    JSON.stringify({
      name: "fake-proxy",
      display_name: "Fake Proxy Provider",
      enabled: true,
      api_keys: { env_var_patterns: ["FAKE_PROXY_API_KEY", "FAKE_PROXY_API_KEY_{INDEX}"] },
      endpoints: {
        base_url: "https://fake-proxy.local/v1",
        completions: "/chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
      error_handling: { "429": { action: "provider_cooldown", cooldown_seconds: 0 } },
      egress_proxies: {
        enabled: true,
        env_var_patterns: ["FAKE_PROXY_EGRESS_PROXY", "FAKE_PROXY_EGRESS_PROXY_{INDEX}"],
        cooldown_seconds: 0,
      },
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-proxy-model.json"),
    JSON.stringify({
      logical_name: "fake-proxy-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fake-proxy", model: "fake-backend", wire_protocol: "openai" },
      ],
    }),
  );

  // Register FakeProvider for the lifetime of these tests.
  providerRegistry.registerProvider("fake", () => new FakeProvider());
  providerRegistry.registerProvider("fake-proxy", () => new FakeProvider());

  // Ensure env has the key the API key manager will parse.
  process.env.FAKE_API_KEY = "test-key-aaaa";
});

afterAll(() => {
  providerRegistry.unregisterProvider("fake");
  providerRegistry.unregisterProvider("fake-proxy");
  resetKeyState("fake");
  resetKeyState("fake-proxy");
  resetProxyState("fake-proxy");
  delete process.env.FAKE_API_KEY;
  delete process.env.FAKE_PROXY_API_KEY_1;
  delete process.env.FAKE_PROXY_API_KEY_2;
  delete process.env.FAKE_PROXY_EGRESS_PROXY_1;
  delete process.env.FAKE_PROXY_EGRESS_PROXY_2;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("FallbackRouter", () => {
  test("happy path returns provider response", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: "chatcmpl-x",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];

    const router = new FallbackRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-model",
      requestData: {
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(
      ((result["choices"] as Array<Record<string, unknown>>)[0]?.[
        "message"
      ] as Record<string, unknown>)["content"],
    ).toBe("hello");
    expect(FakeProvider.calls.length).toBe(1);
    expect(FakeProvider.calls[0]?.ctx.apiKey).toBe("test-key-aaaa");
  });

  test("throws RoutingError when the provider returns a fallback-worthy error", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      new ProviderAPIError("500 boom", 500, { provider: "fake", body: "{}" }),
    ];

    const router = new FallbackRouter();
    await expect(
      router.callWithFallback({
        logicalModel: "fake-model",
        requestData: {
          model: "fake-model",
          messages: [{ role: "user", content: "hi" }],
        },
        targetProtocol: "openai",
      }),
    ).rejects.toMatchObject({ name: "RoutingError" });
  });

  test("passes stop / tools / temperature through", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: "x",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      },
    ];

    const router = new FallbackRouter();
    await router.callWithFallback({
      logicalModel: "fake-model",
      requestData: {
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
        temperature: 0.2,
        stop: ["END"],
      },
      targetProtocol: "openai",
    });

    const args = FakeProvider.calls[0]?.args;
    expect(args?.temperature).toBe(0.2);
    expect(args?.stop).toEqual(["END"]);
  });

  test("tries every proxy for a key before rotating to the next API key", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      new ProviderAPIError("429 first", 429, { provider: "fake-proxy", body: "RateLimitError" }),
      new ProviderAPIError("429 second", 429, { provider: "fake-proxy", body: "RateLimitError" }),
      { id: "ok", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] },
    ];
    resetKeyState("fake-proxy");
    resetProxyState("fake-proxy");
    providerConfigLoader.clearCache();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("MODEL_PROXY_EGRESS_PROXY") || key.startsWith("FAKE_PROXY_EGRESS_PROXY")) delete process.env[key];
    }
    process.env.FAKE_PROXY_API_KEY_1 = "key-one";
    process.env.FAKE_PROXY_API_KEY_2 = "key-two";
    process.env.FAKE_PROXY_EGRESS_PROXY_1 = "http://proxy-one:8080";
    process.env.FAKE_PROXY_EGRESS_PROXY_2 = "http://proxy-two:8080";

    const router = new FallbackRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-proxy-model",
      requestData: { model: "fake-proxy-model", messages: [{ role: "user", content: "hi" }] },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("ok");
    expect(FakeProvider.calls.slice(0, 2).map((call) => [call.ctx.apiKey, call.ctx.egressProxyUrl])).toEqual([
      ["key-one", "http://proxy-one:8080"],
      ["key-one", "http://proxy-two:8080"],
    ]);
    expect(FakeProvider.calls[2]?.ctx.egressProxyUrl).toBe("http://proxy-one:8080");
  });

});
