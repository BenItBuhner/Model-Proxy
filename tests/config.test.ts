import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ModelConfigLoader } from "../src/config/model-loader.ts";
import { ProviderConfigLoader } from "../src/config/provider-loader.ts";
import {
  ModelRoutingConfigSchema,
  RouteConfigSchema,
} from "../shared/schemas/routing.ts";
import { EnforceToolCallConfigSchema } from "../shared/schemas/enforce.ts";

const tmpRoot = join(
  tmpdir(),
  `mp-v2-config-${process.pid}-${Date.now()}`,
);

beforeAll(() => {
  mkdirSync(join(tmpRoot, "models"), { recursive: true });
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });

  writeFileSync(
    join(tmpRoot, "models", "test-model.json"),
    JSON.stringify({
      logical_name: "test-model",
      timeout_seconds: 30,
      default_cooldown_seconds: 60,
      enforce_tool_call: {
        enabled: true,
        max_retries: 5,
      },
      model_routings: [
        {
          provider: "groq",
          model: "llama-3.1-70b",
          wire_protocol: "openai",
        },
      ],
      fallback_model_routings: ["other-model"],
    }),
  );

  writeFileSync(
    join(tmpRoot, "providers", "groq.json"),
    JSON.stringify({
      name: "groq",
      display_name: "Groq",
      enabled: true,
      api_keys: {
        env_var_patterns: ["GROQ_API_KEY", "GROQ_API_KEY_{INDEX}"],
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
    }),
  );
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("zod schemas", () => {
  test("EnforceToolCallConfig accepts partial config", () => {
    expect(
      EnforceToolCallConfigSchema.parse({ enabled: true }),
    ).toMatchObject({ enabled: true });
  });

  test("RouteConfig requires provider + model", () => {
    const result = RouteConfigSchema.safeParse({ provider: "groq" });
    expect(result.success).toBe(false);
  });

  test("RouteConfig accepts optional context_window", () => {
    const result = RouteConfigSchema.safeParse({
      provider: "groq",
      model: "llama-3.1-70b",
      context_window: 131072,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context_window).toBe(131072);
    }
  });

  test("RouteConfig rejects non-positive context_window", () => {
    const result = RouteConfigSchema.safeParse({
      provider: "groq",
      model: "llama-3.1-70b",
      context_window: 0,
    });
    expect(result.success).toBe(false);
  });

  test("ModelRoutingConfig accepts model-level context_window", () => {
    const result = ModelRoutingConfigSchema.safeParse({
      logical_name: "x",
      context_window: 200000,
      model_routings: [{ provider: "a", model: "b" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context_window).toBe(200000);
    }
  });

  test("ModelRoutingConfig needs at least one routing", () => {
    const result = ModelRoutingConfigSchema.safeParse({
      logical_name: "x",
      model_routings: [],
    });
    expect(result.success).toBe(false);
  });

  test("ModelRoutingConfig rejects unknown top-level keys", () => {
    const result = ModelRoutingConfigSchema.safeParse({
      logical_name: "x",
      model_routings: [{ provider: "a", model: "b" }],
      random_extra: 1,
    });
    expect(result.success).toBe(false);
  });
});

describe("ModelConfigLoader", () => {
  test("loads a valid per-model config", () => {
    const loader = new ModelConfigLoader({ configDir: join(tmpRoot, "models") });
    const cfg = loader.loadConfig("test-model");
    expect(cfg.logical_name).toBe("test-model");
    expect(cfg.model_routings[0]?.provider).toBe("groq");
    expect(cfg.enforce_tool_call?.enabled).toBe(true);
    expect(cfg.enforce_tool_call?.max_retries).toBe(5);
    expect(cfg.fallback_model_routings).toEqual(["other-model"]);
  });

  test("lists available models", () => {
    const loader = new ModelConfigLoader({ configDir: join(tmpRoot, "models") });
    expect(loader.getAvailableModels()).toContain("test-model");
  });

  test("throws when a model config is missing", () => {
    const loader = new ModelConfigLoader({ configDir: join(tmpRoot, "models") });
    expect(() => loader.loadConfig("missing-model")).toThrow();
  });
});

describe("ProviderConfigLoader", () => {
  test("loads a valid provider config", () => {
    const loader = new ProviderConfigLoader({ configDir: tmpRoot });
    const cfg = loader.loadProvider("groq");
    expect(cfg.name).toBe("groq");
    expect(cfg.endpoints.base_url).toContain("groq.com");
    expect(cfg.authentication.type).toBe("bearer");
  });

  test("lists available providers", () => {
    const loader = new ProviderConfigLoader({ configDir: tmpRoot });
    expect(loader.getAvailableProviders()).toContain("groq");
  });
});
