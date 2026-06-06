import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { modelConfigLoader } from "../src/config/model-loader.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import {
  EnforceRouter,
  EnforceValidationError,
} from "../src/routing/enforce/index.ts";
import { FallbackRouter } from "../src/routing/fallback.ts";
import type {
  AnthropicCallArgs,
  BaseProvider,
  OpenAICallArgs,
  ProviderCallContext,
} from "../src/providers/base.ts";

const tmpRoot = join(tmpdir(), `mp-v2-enforce-${process.pid}-${Date.now()}`);

(modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
(modelConfigLoader as unknown as { pathsArePlainModelDirs: boolean }).pathsArePlainModelDirs = false;

const FLAG = '{"tool_loop":"completed"}';

class FakeProvider implements BaseProvider {
  readonly providerName = "fakex";
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
  mkdirSync(join(tmpRoot, "models"), { recursive: true });
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });

  writeFileSync(
    join(tmpRoot, "providers", "fakex.json"),
    JSON.stringify({
      name: "fakex",
      display_name: "Fake X",
      enabled: true,
      api_keys: { env_var_patterns: ["FAKEX_API_KEY", "FAKEX_API_KEY_{INDEX}"] },
      endpoints: {
        base_url: "https://fakex.local/v1",
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
    join(tmpRoot, "models", "enforce-model.json"),
    JSON.stringify({
      logical_name: "enforce-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      enforce_tool_call: { enabled: true, max_retries: 3 },
      model_routings: [
        { provider: "fakex", model: "fakex-backend", wire_protocol: "openai" },
      ],
    }),
  );

  process.env.FAKEX_API_KEY = "test-fakex-aaaa";
  providerRegistry.registerProvider("fakex", () => new FakeProvider());
});

afterAll(() => {
  providerRegistry.unregisterProvider("fakex");
  resetKeyState("fakex");
  delete process.env.FAKEX_API_KEY;
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  FakeProvider.calls = [];
  FakeProvider.responses = [];
});

describe("EnforceRouter", () => {
  test("bypasses validation when enabled=false", async () => {
    const router = new EnforceRouter(new FallbackRouter());
    FakeProvider.responses = [
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "free text" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    const result = await router.call({
      logicalModel: "enforce-model",
      requestData: { model: "enforce-model", messages: [{ role: "user", content: "hi" }] },
      targetProtocol: "openai",
      overrides: { header: "false" },
    });
    const choices = result["choices"] as Array<Record<string, unknown>>;
    expect(
      (choices[0]?.["message"] as Record<string, unknown>)["content"],
    ).toBe("free text");
    expect(FakeProvider.calls.length).toBe(1);
  });

  test("validates and strips termination flag; sets content=null for flag-only", async () => {
    const router = new EnforceRouter(new FallbackRouter());
    FakeProvider.responses = [
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: FLAG },
            finish_reason: "stop",
          },
        ],
      },
    ];
    const result = await router.call({
      logicalModel: "enforce-model",
      requestData: { model: "enforce-model", messages: [{ role: "user", content: "hi" }] },
      targetProtocol: "openai",
    });
    const choice = (result["choices"] as Array<Record<string, unknown>>)[0] as Record<
      string,
      unknown
    >;
    const message = choice["message"] as Record<string, unknown>;
    expect(message["content"]).toBeNull();
    expect(choice["finish_reason"]).toBe("stop");
  });

  test("retries when first response is empty and accepts second response with flag", async () => {
    const router = new EnforceRouter(new FallbackRouter());
    FakeProvider.responses = [
      {
        choices: [
          { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
        ],
      },
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `here: ${FLAG}` },
            finish_reason: "stop",
          },
        ],
      },
    ];

    const result = await router.call({
      logicalModel: "enforce-model",
      requestData: { model: "enforce-model", messages: [{ role: "user", content: "hi" }] },
      targetProtocol: "openai",
    });
    const choices = result["choices"] as Array<Record<string, unknown>>;
    expect(
      (choices[0]?.["message"] as Record<string, unknown>)["content"],
    ).toBe("here:");
    expect(FakeProvider.calls.length).toBe(2);
  });

  test("throws EnforceValidationError after exhausting retries", async () => {
    const router = new EnforceRouter(new FallbackRouter());
    for (let i = 0; i < 3; i++) {
      FakeProvider.responses.push({
        choices: [
          { index: 0, message: { role: "assistant", content: "   " }, finish_reason: "stop" },
        ],
      });
    }

    await expect(
      router.call({
        logicalModel: "enforce-model",
        requestData: { model: "enforce-model", messages: [{ role: "user", content: "hi" }] },
        targetProtocol: "openai",
      }),
    ).rejects.toBeInstanceOf(EnforceValidationError);
    expect(FakeProvider.calls.length).toBe(3);
  });

  test("retry does not grow context with stale correction messages", async () => {
    const router = new EnforceRouter(new FallbackRouter());
    FakeProvider.responses = [
      {
        choices: [
          { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
        ],
      },
      {
        choices: [
          { index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" },
        ],
      },
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `done ${FLAG}` },
            finish_reason: "stop",
          },
        ],
      },
    ];

    await router.call({
      logicalModel: "enforce-model",
      requestData: { model: "enforce-model", messages: [{ role: "user", content: "hi" }] },
      targetProtocol: "openai",
    });

    // Third attempt should be: [system(guidance), user(original), user(retry #2)]
    // The context should NOT carry retry #1's correction message.
    const thirdAttempt = FakeProvider.calls[2]?.args.messages as Array<
      Record<string, unknown>
    >;
    expect(thirdAttempt.length).toBe(3);
    expect(thirdAttempt[0]?.["role"]).toBe("system");
    expect(thirdAttempt[1]?.["role"]).toBe("user");
    expect(thirdAttempt[1]?.["content"]).toBe("hi");
    expect(thirdAttempt[2]?.["role"]).toBe("user");
    // The marker has been scrubbed before dispatch.
    expect("__mp_enforce_retry" in (thirdAttempt[2] ?? {})).toBe(false);
    // Only ONE retry correction message in the dispatched request.
    const retryMessages = thirdAttempt.filter((m) =>
      String(m["content"]).toLowerCase().includes("proxy retry"),
    );
    expect(retryMessages.length).toBe(1);
  });

  test("forwards extraHeaders to upstream provider", async () => {
    const router = new EnforceRouter(new FallbackRouter());
    FakeProvider.responses = [
      {
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: FLAG },
            finish_reason: "stop",
          },
        ],
      },
    ];
    await router.call({
      logicalModel: "enforce-model",
      requestData: { model: "enforce-model", messages: [{ role: "user", content: "hi" }] },
      targetProtocol: "openai",
      extraHeaders: {
        "x-opencode-session": "session-abc",
        "x-opencode-request": "req-xyz",
      },
    });
    const ctx = FakeProvider.calls[0]?.ctx;
    expect(ctx?.extraHeaders?.["x-opencode-session"]).toBe("session-abc");
    expect(ctx?.extraHeaders?.["x-opencode-request"]).toBe("req-xyz");
  });

  test("streaming emulates SSE frames after validated non-streaming response", async () => {
    const router = new EnforceRouter(new FallbackRouter());
    FakeProvider.responses = [
      {
        id: "chatcmpl-x",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `hello ${FLAG}` },
            finish_reason: "stop",
          },
        ],
      },
    ];

    const chunks: string[] = [];
    for await (const chunk of router.stream({
      logicalModel: "enforce-model",
      requestData: { model: "enforce-model", messages: [{ role: "user", content: "hi" }] },
      targetProtocol: "openai",
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[chunks.length - 1]).toBe("data: [DONE]\n\n");
    // The first SSE data frame should contain the stripped content.
    const firstPayload = chunks[0] ?? "";
    expect(firstPayload).toContain("hello");
    expect(firstPayload).not.toContain("tool_loop");
  });
});
