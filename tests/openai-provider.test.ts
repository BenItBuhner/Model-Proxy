import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  isChatTemplateKwargsPassthroughDisabled,
  OpenAIProvider,
} from "../src/providers/openai-provider.ts";
import type { OpenAICallArgs } from "../src/providers/base.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { getConfigSearchPaths } from "../src/config/paths.ts";

const ENV_KEY = "DISABLE_CHAT_TEMPLATE_KWARGS_PASSTHROUGH";
let savedEnv: string | undefined;
let savedSearchPaths: string[] | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
  // Reset provider loader search paths so singleton pollution from other
  // test files (e.g. admin-events) doesn't break instantiation here.
  const loader = providerConfigLoader as unknown as { searchPaths?: string[] };
  if (loader.searchPaths !== undefined) {
    savedSearchPaths = [...loader.searchPaths];
    loader.searchPaths = getConfigSearchPaths();
  }
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = savedEnv;
  if (savedSearchPaths !== undefined) {
    const loader = providerConfigLoader as unknown as { searchPaths?: string[] };
    loader.searchPaths = savedSearchPaths;
    savedSearchPaths = undefined;
  }
});

function makeProvider(name = "nvidia"): OpenAIProvider {
  return new OpenAIProvider(name);
}

function baseArgs(overrides: Partial<OpenAICallArgs> = {}): OpenAICallArgs {
  return {
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    ...overrides,
  };
}

describe("isChatTemplateKwargsPassthroughDisabled", () => {
  test("default (env unset) is false", () => {
    delete process.env[ENV_KEY];
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(false);
  });

  test("'1' disables", () => {
    process.env[ENV_KEY] = "1";
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(true);
  });

  test("'true' disables (case-insensitive)", () => {
    process.env[ENV_KEY] = "TRUE";
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(true);
  });

  test("'yes' disables", () => {
    process.env[ENV_KEY] = "yes";
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(true);
  });

  test("'on' disables", () => {
    process.env[ENV_KEY] = "on";
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(true);
  });

  test("whitespace is trimmed", () => {
    process.env[ENV_KEY] = "  true  ";
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(true);
  });

  test("arbitrary string is not disabling", () => {
    process.env[ENV_KEY] = "potato";
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(false);
  });

  test("empty string is not disabling", () => {
    process.env[ENV_KEY] = "";
    expect(isChatTemplateKwargsPassthroughDisabled()).toBe(false);
  });
});

describe("OpenAIProvider buildPayload: chat_template_kwargs passthrough", () => {
  test("forwards chat_template_kwargs by default (env unset)", () => {
    const provider = makeProvider();
    const args = baseArgs({
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    });
    const payload = provider["buildPayload"](args);
    expect(payload["chat_template_kwargs"]).toEqual({
      enable_thinking: false,
      force_nonempty_content: true,
    });
  });

  test("omits chat_template_kwargs when not provided", () => {
    const provider = makeProvider();
    const payload = provider["buildPayload"](baseArgs());
    expect("chat_template_kwargs" in payload).toBe(false);
  });

  test("drops chat_template_kwargs when env var disables passthrough", () => {
    process.env[ENV_KEY] = "1";
    const provider = makeProvider();
    const args = baseArgs({
      chat_template_kwargs: { enable_thinking: false },
    });
    const payload = provider["buildPayload"](args);
    expect("chat_template_kwargs" in payload).toBe(false);
  });

  test("passthrough works for non-Nvidia providers (e.g. openai)", () => {
    const provider = makeProvider("openai");
    const args = baseArgs({
      chat_template_kwargs: { custom_flag: "x" },
    });
    const payload = provider["buildPayload"](args);
    expect(payload["chat_template_kwargs"]).toEqual({ custom_flag: "x" });
  });

  test("does not interfere with other passthrough fields", () => {
    const provider = makeProvider();
    const args = baseArgs({
      temperature: 0.5,
      top_p: 0.9,
      max_tokens: 256,
      chat_template_kwargs: { enable_thinking: true },
    });
    const payload = provider["buildPayload"](args);
    expect(payload["temperature"]).toBe(0.5);
    expect(payload["top_p"]).toBe(0.9);
    expect(payload["max_tokens"]).toBe(256);
    expect(payload["chat_template_kwargs"]).toEqual({ enable_thinking: true });
  });

  test("forwards max_completion_tokens when max_tokens is absent", () => {
    const provider = makeProvider();
    const payload = provider["buildPayload"](
      baseArgs({ max_completion_tokens: 1024 }),
    );

    expect(payload["max_completion_tokens"]).toBe(1024);
    expect("max_tokens" in payload).toBe(false);
  });
});
