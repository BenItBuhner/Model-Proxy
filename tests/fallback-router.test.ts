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
import {
  ProviderAPIError,
  ProviderTimeoutError,
} from "../src/providers/errors.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { resetProxyState } from "../src/providers/egress-proxy-manager.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { FallbackRouter } from "../src/routing/fallback.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import type { Principal } from "../src/storage/identity-store.ts";

const tmpRoot = join(tmpdir(), `mp-v2-routing-${process.pid}-${Date.now()}`);

const ownerPrincipal: Principal = {
  id: "test-owner",
  userId: "test-owner",
  apiKeyId: undefined,
  email: "owner@example.test",
  role: "owner",
  isOwner: true,
  scopes: ["*"],
  authMethod: "no-auth",
  ownerBypass: true,
  completionLoggingEnabled: false,
};

function makeRouter(
  options: Omit<ConstructorParameters<typeof FallbackRouter>[0], "principal"> = {},
): FallbackRouter {
  return new FallbackRouter({ ...options, principal: ownerPrincipal });
}

// Replace the singleton loader's config dir at module-scope by a fresh loader
// pointing at our sandbox (via monkey-patched internals).
(modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
(modelConfigLoader as unknown as { pathsArePlainModelDirs: boolean }).pathsArePlainModelDirs = false;
(providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];

interface DelayedFakeResponse {
  delayMs: number;
  body: Record<string, unknown>;
}

class FakeProvider implements BaseProvider {
  readonly providerName = "fake";
  readonly wireProtocol = "openai" as const;
  readonly config = {} as BaseProvider["config"];

  static calls: Array<{ args: OpenAICallArgs; ctx: ProviderCallContext }> = [];
  static responses: Array<Record<string, unknown> | Error | DelayedFakeResponse> = [];
  static streamResponses: Array<Array<string | { delayMs: number; chunk: string }> | Error> = [];

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
    if (isDelayedFakeResponse(next)) {
      await testSleep(next.delayMs);
      if (ctx.signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
      return next.body;
    }
    return next;
  }

  async *streamOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown> {
    FakeProvider.calls.push({ args, ctx });
    const next = FakeProvider.streamResponses.shift();
    if (next === undefined) throw new Error("No stream response queued");
    if (next instanceof Error) throw next;
    for (const item of next) {
      const chunk = typeof item === "string" ? item : item.chunk;
      const delayMs = typeof item === "string" ? 0 : item.delayMs;
      if (delayMs > 0) await testSleep(delayMs);
      if (ctx.signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
      yield chunk;
    }
  }

  async callAnthropic(
    _args: AnthropicCallArgs,
    _ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }
}

function testSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDelayedFakeResponse(value: unknown): value is DelayedFakeResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DelayedFakeResponse).delayMs === "number" &&
    typeof (value as DelayedFakeResponse).body === "object" &&
    (value as DelayedFakeResponse).body !== null
  );
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
    join(tmpRoot, "models", "fake-timeout-model.json"),
    JSON.stringify({
      logical_name: "fake-timeout-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fake", model: "fake-timeout-backend", wire_protocol: "openai" },
        { provider: "fake", model: "fake-success-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-connect-model.json"),
    JSON.stringify({
      logical_name: "fake-connect-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        {
          provider: "fake",
          model: "fake-connect-backend",
          wire_protocol: "openai",
          api_key_env: ["FAKE_API_KEY"],
        },
        { provider: "fake", model: "fake-success-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-empty-response-model.json"),
    JSON.stringify({
      logical_name: "fake-empty-response-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fake", model: "fake-empty-backend", wire_protocol: "openai" },
        { provider: "fake", model: "fake-success-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-capability-model.json"),
    JSON.stringify({
      logical_name: "fake-capability-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        {
          provider: "fake",
          model: "fake-text-only-backend",
          wire_protocol: "openai",
          capabilities: { multimodal: false },
        },
        {
          provider: "fake",
          model: "fake-vision-backend",
          wire_protocol: "openai",
          capabilities: { multimodal: true },
        },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-context-model.json"),
    JSON.stringify({
      logical_name: "fake-context-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        {
          provider: "fake",
          model: "fake-small-context-backend",
          wire_protocol: "openai",
          context_window: 5,
        },
        {
          provider: "fake",
          model: "fake-large-context-backend",
          wire_protocol: "openai",
          context_window: 10000,
        },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-all-ineligible-model.json"),
    JSON.stringify({
      logical_name: "fake-all-ineligible-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        {
          provider: "fake",
          model: "fake-text-only-backend",
          wire_protocol: "openai",
          capabilities: { multimodal: false },
        },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-hedged-capability-model.json"),
    JSON.stringify({
      logical_name: "fake-hedged-capability-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      hedged_routing: {
        enabled: true,
        min_parallel: 2,
        max_parallel: 2,
        stagger_ms: 0,
        primary_bias: 0.9,
      },
      model_routings: [
        {
          provider: "fake",
          model: "fake-hedged-text-only",
          wire_protocol: "openai",
          capabilities: { multimodal: false },
        },
        {
          provider: "fake",
          model: "fake-hedged-vision",
          wire_protocol: "openai",
          capabilities: { multimodal: true },
        },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-transient-error-model.json"),
    JSON.stringify({
      logical_name: "fake-transient-error-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fake", model: "fake-json-backend", wire_protocol: "openai" },
        { provider: "fake", model: "fake-operation-timeout-backend", wire_protocol: "openai" },
        { provider: "fake", model: "fake-success-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-openai-extensions-model.json"),
    JSON.stringify({
      logical_name: "fake-openai-extensions-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        {
          provider: "fake",
          model: "fake-extensions-backend",
          wire_protocol: "openai",
          openai_body_extensions: {
            chat_template_kwargs: {
              enable_thinking: true,
              clear_thinking: false,
            },
          },
        },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-openai-defaults-model.json"),
    JSON.stringify({
      logical_name: "fake-openai-defaults-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        {
          provider: "fake",
          model: "fake-defaults-backend",
          wire_protocol: "openai",
          openai_body_defaults: {
            max_tokens: 131072,
            temperature: 0.1,
          },
        },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-hedged-model.json"),
    JSON.stringify({
      logical_name: "fake-hedged-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      hedged_routing: {
        enabled: true,
        min_parallel: 2,
        max_parallel: 2,
        stagger_ms: 0,
        primary_bias: 0.9,
      },
      model_routings: [
        { provider: "fake", model: "fake-slow-primary", wire_protocol: "openai" },
        { provider: "fake", model: "fake-fast-secondary", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-hedged-stream-model.json"),
    JSON.stringify({
      logical_name: "fake-hedged-stream-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      hedged_routing: {
        enabled: true,
        min_parallel: 2,
        max_parallel: 2,
        stagger_ms: 0,
        primary_bias: 0.9,
        stream_min_content_chars: 1,
      },
      model_routings: [
        { provider: "fake", model: "fake-stream-primary", wire_protocol: "openai" },
        { provider: "fake", model: "fake-stream-secondary", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-hedged-wave-model.json"),
    JSON.stringify({
      logical_name: "fake-hedged-wave-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      hedged_routing: {
        enabled: true,
        min_parallel: 2,
        max_parallel: 2,
        stagger_ms: 0,
        primary_bias: 0.9,
      },
      model_routings: [
        { provider: "fake", model: "fake-wave-primary", wire_protocol: "openai" },
        { provider: "fake", model: "fake-wave-secondary", wire_protocol: "openai" },
        { provider: "fake", model: "fake-wave-tertiary", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-hedged-wave-stream-model.json"),
    JSON.stringify({
      logical_name: "fake-hedged-wave-stream-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      hedged_routing: {
        enabled: true,
        min_parallel: 2,
        max_parallel: 2,
        stagger_ms: 0,
        primary_bias: 0.9,
        stream_min_content_chars: 1,
      },
      model_routings: [
        { provider: "fake", model: "fake-wave-stream-primary", wire_protocol: "openai" },
        { provider: "fake", model: "fake-wave-stream-secondary", wire_protocol: "openai" },
        { provider: "fake", model: "fake-wave-stream-tertiary", wire_protocol: "openai" },
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

  writeFileSync(
    join(tmpRoot, "models", "fake-hedged-proxy-spread-model.json"),
    JSON.stringify({
      logical_name: "fake-hedged-proxy-spread-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      hedged_routing: {
        enabled: true,
        min_parallel: 4,
        max_parallel: 4,
        stagger_ms: 0,
        primary_bias: 0.95,
      },
      model_routings: [
        { provider: "fake-proxy", model: "fake-proxy-primary", wire_protocol: "openai" },
        { provider: "fake", model: "fake-secondary-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fake-hedged-key-spread-model.json"),
    JSON.stringify({
      logical_name: "fake-hedged-key-spread-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      hedged_routing: {
        enabled: true,
        min_parallel: 2,
        max_parallel: 2,
        stagger_ms: 0,
        primary_bias: 0.95,
      },
      model_routings: [
        {
          provider: "fake",
          model: "fake-missing-primary",
          wire_protocol: "openai",
          api_key_env: ["FAKE_MISSING_KEY"],
        },
        {
          provider: "fake",
          model: "fake-key-heavy",
          wire_protocol: "openai",
          api_key_env: [
            "FAKE_HEDGE_KEY_1",
            "FAKE_HEDGE_KEY_2",
            "FAKE_HEDGE_KEY_3",
            "FAKE_HEDGE_KEY_4",
            "FAKE_HEDGE_KEY_5",
            "FAKE_HEDGE_KEY_6",
            "FAKE_HEDGE_KEY_7",
            "FAKE_HEDGE_KEY_8",
          ],
        },
        {
          provider: "fake",
          model: "fake-late-route",
          wire_protocol: "openai",
          api_key_env: ["FAKE_HEDGE_LAST_KEY"],
        },
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
  delete process.env.FAKE_PROXY_EGRESS_PROXY_3;
  delete process.env.FAKE_PROXY_EGRESS_PROXY_4;
  delete process.env.FAKE_HEDGE_KEY_1;
  delete process.env.FAKE_HEDGE_KEY_2;
  delete process.env.FAKE_HEDGE_KEY_3;
  delete process.env.FAKE_HEDGE_KEY_4;
  delete process.env.FAKE_HEDGE_KEY_5;
  delete process.env.FAKE_HEDGE_KEY_6;
  delete process.env.FAKE_HEDGE_KEY_7;
  delete process.env.FAKE_HEDGE_KEY_8;
  delete process.env.FAKE_HEDGE_LAST_KEY;
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

    const router = makeRouter();
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

  test("normalizes malformed OpenAI response ids before returning", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: null,
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: null,
                  function: { name: "lookup", arguments: { q: "demo" } },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-model",
      requestData: {
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(typeof result["id"]).toBe("string");
    expect(result["object"]).toBe("chat.completion");
    expect(typeof result["created"]).toBe("number");
    expect(result["model"]).toBe("fake-model");
    const message = ((result["choices"] as Array<Record<string, unknown>>)[0]?.[
      "message"
    ] ?? {}) as Record<string, unknown>;
    const toolCall = (message["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    expect(toolCall["id"]).toBe("call_0");
    expect((toolCall["function"] as Record<string, unknown>)["arguments"]).toBe('{"q":"demo"}');
  });

  test("skips non-multimodal routes for image requests", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: "vision",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "saw it" },
            finish_reason: "stop",
          },
        ],
      },
    ];

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-capability-model",
      requestData: {
        model: "fake-capability-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is this?" },
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("vision");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-vision-backend",
    ]);
  });

  test("skips routes whose declared context window is too small", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: "large-context",
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

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-context-model",
      requestData: {
        model: "fake-context-model",
        messages: [{ role: "user", content: "this request is definitely longer than five tokens" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("large-context");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-large-context-backend",
    ]);
  });

  test("throws RoutingError when every route is ineligible", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [];

    const router = makeRouter();
    await expect(
      router.callWithFallback({
        logicalModel: "fake-all-ineligible-model",
        requestData: {
          model: "fake-all-ineligible-model",
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
              ],
            },
          ],
        },
        targetProtocol: "openai",
      }),
    ).rejects.toMatchObject({
      name: "RoutingError",
      errors: [
        {
          error: "multimodal_unsupported",
          error_type: "RouteEligibilityError",
        },
      ],
    });
    expect(FakeProvider.calls).toEqual([]);
  });

  test("hedged non-streaming routing returns the first valid response and aborts losers", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        delayMs: 50,
        body: {
          id: "slow-primary",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "slow" },
              finish_reason: "stop",
            },
          ],
        },
      },
      {
        id: "fast-secondary",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fast" },
            finish_reason: "stop",
          },
        ],
      },
    ];

    const router = makeRouter({ random: () => 0.5 });
    const result = await router.callWithFallback({
      logicalModel: "fake-hedged-model",
      requestData: {
        model: "fake-hedged-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("fast-secondary");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-slow-primary",
      "fake-fast-secondary",
    ]);
    expect(FakeProvider.calls[0]?.ctx.signal?.aborted).toBe(true);
  });

  test("hedged routing filters non-multimodal candidates before launch", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: "hedged-vision",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "vision" },
            finish_reason: "stop",
          },
        ],
      },
    ];

    const router = makeRouter({ random: () => 0.5 });
    const result = await router.callWithFallback({
      logicalModel: "fake-hedged-capability-model",
      requestData: {
        model: "fake-hedged-capability-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            ],
          },
        ],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("hedged-vision");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-hedged-vision",
    ]);
  });

  test("hedged routing includes a secondary route even when primary has many proxy variants", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        delayMs: 50,
        body: {
          id: "primary-1",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "primary" },
              finish_reason: "stop",
            },
          ],
        },
      },
      {
        id: "secondary-fast",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "secondary" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");
    resetKeyState("fake-proxy");
    resetProxyState("fake-proxy");
    process.env.FAKE_PROXY_API_KEY_1 = "key-one";
    process.env.FAKE_PROXY_EGRESS_PROXY_1 = "http://proxy-one:8080";
    process.env.FAKE_PROXY_EGRESS_PROXY_2 = "http://proxy-two:8080";
    process.env.FAKE_PROXY_EGRESS_PROXY_3 = "http://proxy-three:8080";
    process.env.FAKE_PROXY_EGRESS_PROXY_4 = "http://proxy-four:8080";

    const router = makeRouter({ random: () => 0.99 });
    const result = await router.callWithFallback({
      logicalModel: "fake-hedged-proxy-spread-model",
      requestData: {
        model: "fake-hedged-proxy-spread-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("secondary-fast");
    expect(FakeProvider.calls.map((call) => call.args.model)).toContain("fake-secondary-backend");
  });

  test("hedged routing samples later routes before expanding one route's key variants", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        delayMs: 50,
        body: {
          id: "key-heavy",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "slow" },
              finish_reason: "stop",
            },
          ],
        },
      },
      {
        id: "late-route",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fast" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");
    for (let i = 1; i <= 8; i += 1) {
      process.env[`FAKE_HEDGE_KEY_${i}`] = `key-${i}`;
    }
    process.env.FAKE_HEDGE_LAST_KEY = "last-key";

    const router = makeRouter({ random: () => 0.5 });
    const result = await router.callWithFallback({
      logicalModel: "fake-hedged-key-spread-model",
      requestData: {
        model: "fake-hedged-key-spread-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("late-route");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-key-heavy",
      "fake-late-route",
    ]);
  });

  test("hedged streaming replays only the winning stream buffer", async () => {
    FakeProvider.calls = [];
    FakeProvider.streamResponses = [
      [
        'data: {"id":"primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
        {
          delayMs: 50,
          chunk:
            'data: {"id":"primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"slow"}}]}\n\n',
        },
      ],
      [
        'data: {"id":"secondary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
        'data: {"id":"secondary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"fast"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
    ];

    const router = makeRouter({ random: () => 0.5 });
    const chunks: string[] = [];
    for await (const chunk of router.streamWithFallback({
      logicalModel: "fake-hedged-stream-model",
      requestData: {
        model: "fake-hedged-stream-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      'data: {"id":"secondary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}\n\n',
      'data: {"id":"secondary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"fast"}}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    expect(chunks.join("")).not.toContain("primary");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-stream-primary",
      "fake-stream-secondary",
    ]);
    expect(FakeProvider.calls[0]?.ctx.signal?.aborted).toBe(true);
  });

  test("hedged streaming treats OpenAI reasoning deltas as meaningful output", async () => {
    FakeProvider.calls = [];
    FakeProvider.streamResponses = [
      [
        'data: {"id":"primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"id":"primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
      [
        {
          delayMs: 50,
          chunk:
            'data: {"id":"secondary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"fast"}}]}\n\n',
        },
        "data: [DONE]\n\n",
      ],
    ];

    const router = makeRouter({ random: () => 0.5 });
    const chunks: string[] = [];
    for await (const chunk of router.streamWithFallback({
      logicalModel: "fake-hedged-stream-model",
      requestData: {
        model: "fake-hedged-stream-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("reasoning_content");
    expect(chunks.join("")).toContain("primary");
    expect(chunks.join("")).not.toContain("secondary");
  });

  test("sequential streaming treats OpenAI reasoning deltas as meaningful for tool requests", async () => {
    FakeProvider.calls = [];
    FakeProvider.streamResponses = [
      [
        'data: {"id":"reasoning-only","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"id":"reasoning-only","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking through the tool request"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
    ];

    const router = makeRouter();
    const chunks: string[] = [];
    for await (const chunk of router.streamWithFallback({
      logicalModel: "fake-model",
      requestData: {
        model: "fake-model",
        messages: [{ role: "user", content: "write a file" }],
        tools: [
          {
            type: "function",
            function: { name: "write", parameters: { type: "object" } },
          },
        ],
        stream: true,
      },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("reasoning_content");
    expect(chunks).toContain("data: [DONE]\n\n");
  });

  test("single-route streaming passes through empty upstream stream instead of throwing", async () => {
    FakeProvider.calls = [];
    FakeProvider.streamResponses = [
      [
        'data: {"id":"empty","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ],
    ];

    const router = makeRouter();
    const chunks: string[] = [];
    for await (const chunk of router.streamWithFallback({
      logicalModel: "fake-model",
      requestData: {
        model: "fake-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      'data: {"id":"empty","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
  });

  test("hedged streaming does not select reasoning-only chunks for tool requests", async () => {
    FakeProvider.calls = [];
    FakeProvider.streamResponses = [
      [
        'data: {"id":"primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"id":"primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}\n\n',
        {
          delayMs: 50,
          chunk:
            'data: {"id":"primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"slow","type":"function","function":{"name":"write","arguments":"{}"}}]}}]}\n\n',
        },
      ],
      [
        'data: {"id":"secondary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":""}}]}\n\n',
        'data: {"id":"secondary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"fast","type":"function","function":{"name":"write","arguments":"{}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ],
    ];

    const router = makeRouter({ random: () => 0.5 });
    const chunks: string[] = [];
    for await (const chunk of router.streamWithFallback({
      logicalModel: "fake-hedged-stream-model",
      requestData: {
        model: "fake-hedged-stream-model",
        messages: [{ role: "user", content: "write a file" }],
        tools: [
          {
            type: "function",
            function: { name: "write", parameters: { type: "object" } },
          },
        ],
        stream: true,
      },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("secondary");
    expect(chunks.join("")).toContain('"id":"fast"');
    expect(chunks.join("")).not.toContain("primary");
    expect(FakeProvider.calls[0]?.ctx.signal?.aborted).toBe(true);
  });

  test("throws RoutingError when the provider returns a fallback-worthy error", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      new ProviderAPIError("500 boom", 500, { provider: "fake", body: "{}" }),
    ];

    const router = makeRouter();
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

  test("falls through to the next route after an upstream timeout", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      new ProviderTimeoutError("Upstream request timed out after 5000ms", 5000),
      {
        id: "timeout-recovered",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-timeout-model",
      requestData: {
        model: "fake-timeout-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("timeout-recovered");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-timeout-backend",
      "fake-success-backend",
    ]);
  });

  test("falls through after a provider aborts the upstream operation", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      new DOMException("The operation was aborted.", "AbortError"),
      {
        id: "abort-recovered",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-timeout-model",
      requestData: {
        model: "fake-timeout-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("abort-recovered");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-timeout-backend",
      "fake-success-backend",
    ]);
  });

  test("streaming falls through after a provider aborts before emitting", async () => {
    FakeProvider.calls = [];
    FakeProvider.streamResponses = [
      new DOMException("The operation was aborted.", "AbortError"),
      [
        'data: {"id":"abort-recovered","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"recovered"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const chunks: string[] = [];
    for await (const chunk of router.streamWithFallback({
      logicalModel: "fake-timeout-model",
      requestData: {
        model: "fake-timeout-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("abort-recovered");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-timeout-backend",
      "fake-success-backend",
    ]);
  });

  test("streaming falls through after an empty stop chunk", async () => {
    FakeProvider.calls = [];
    FakeProvider.streamResponses = [
      [
        'data: {"id":"empty-primary","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ],
      [
        'data: {"id":"empty-recovered","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"recovered"}}]}\n\n',
        "data: [DONE]\n\n",
      ],
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const chunks: string[] = [];
    for await (const chunk of router.streamWithFallback({
      logicalModel: "fake-timeout-model",
      requestData: {
        model: "fake-timeout-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }

    expect(chunks.join("")).toContain("empty-recovered");
    expect(chunks.join("")).not.toContain("empty-primary");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-timeout-backend",
      "fake-success-backend",
    ]);
  });

  test("falls through to the next route after a provider connection failure", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      new Error("Unable to connect. Is the computer able to access the url?"),
      {
        id: "connect-recovered",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-connect-model",
      requestData: {
        model: "fake-connect-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("connect-recovered");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-connect-backend",
      "fake-success-backend",
    ]);
  });

  test("falls through after a provider returns an empty assistant message", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: "empty",
        object: "chat.completion",
        created: 1,
        model: "fake-empty-backend",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "",
            },
            finish_reason: "length",
          },
        ],
      },
      {
        id: "empty-recovered",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-empty-response-model",
      requestData: {
        model: "fake-empty-response-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("empty-recovered");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-empty-backend",
      "fake-success-backend",
    ]);
  });

  test("accepts reasoning-only assistant messages as usable output", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      {
        id: "reasoning",
        object: "chat.completion",
        created: 1,
        model: "fake-empty-backend",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "still thinking",
            },
            finish_reason: "length",
          },
        ],
      },
      {
        id: "should-not-fallback",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fallback" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-empty-response-model",
      requestData: {
        model: "fake-empty-response-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("reasoning");
    const choices = result["choices"] as Array<Record<string, unknown>>;
    const message = choices[0]?.["message"] as Record<string, unknown>;
    expect(message["content"]).toBe("");
    expect(message["reasoning_content"]).toBe("still thinking");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-empty-backend",
    ]);
  });

  test("falls through after transient provider parse and operation timeouts", async () => {
    FakeProvider.calls = [];
    FakeProvider.responses = [
      new SyntaxError("Unexpected end of JSON input"),
      new Error("The operation timed out"),
      {
        id: "transient-recovered",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "recovered" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fake");

    const router = makeRouter();
    const result = await router.callWithFallback({
      logicalModel: "fake-transient-error-model",
      requestData: {
        model: "fake-transient-error-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(result["id"]).toBe("transient-recovered");
    expect(FakeProvider.calls.map((call) => call.args.model)).toEqual([
      "fake-json-backend",
      "fake-operation-timeout-backend",
      "fake-success-backend",
    ]);
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

    const router = makeRouter();
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

  test("applies route-level OpenAI body extensions", async () => {
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

    const router = makeRouter();
    await router.callWithFallback({
      logicalModel: "fake-openai-extensions-model",
      requestData: {
        model: "fake-openai-extensions-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });

    expect(FakeProvider.calls[0]?.args.chat_template_kwargs).toEqual({
      enable_thinking: true,
      clear_thinking: false,
    });
  });

  test("applies route-level OpenAI body defaults without overriding client fields", async () => {
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

    const router = makeRouter();
    await router.callWithFallback({
      logicalModel: "fake-openai-defaults-model",
      requestData: {
        model: "fake-openai-defaults-model",
        messages: [{ role: "user", content: "hi" }],
      },
      targetProtocol: "openai",
    });
    await router.callWithFallback({
      logicalModel: "fake-openai-defaults-model",
      requestData: {
        model: "fake-openai-defaults-model",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
      },
      targetProtocol: "openai",
    });

    expect(FakeProvider.calls[0]?.args.max_tokens).toBe(131072);
    expect(FakeProvider.calls[0]?.args.temperature).toBe(0.1);
    expect(FakeProvider.calls[1]?.args.max_tokens).toBe(4096);
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

    const router = makeRouter();
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
