/**
 * Shared test utilities.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { createApp } from "../../src/app.ts";
import type { Server } from "bun";

const TEST_CONFIG_DIR = join(import.meta.dir, "..", ".test-config");

export function setupTestConfig(opts: {
  providers?: Record<string, any>[];
  models?: Record<string, any>[];
} = {}) {
  // Clean up any previous test config
  if (existsSync(TEST_CONFIG_DIR)) rmSync(TEST_CONFIG_DIR, { recursive: true });
  mkdirSync(join(TEST_CONFIG_DIR, "providers"), { recursive: true });
  mkdirSync(join(TEST_CONFIG_DIR, "models"), { recursive: true });

  for (const provider of (opts.providers || [])) {
    writeFileSync(
      join(TEST_CONFIG_DIR, "providers", `${provider.name}.json`),
      JSON.stringify(provider, null, 2)
    );
  }

  for (const model of (opts.models || [])) {
    writeFileSync(
      join(TEST_CONFIG_DIR, "models", `${model.logical_name}.json`),
      JSON.stringify(model, null, 2)
    );
  }

  // Point config search to test dir
  process.env.__TEST_CONFIG_DIR = TEST_CONFIG_DIR;
}

export function cleanupTestConfig() {
  if (existsSync(TEST_CONFIG_DIR)) {
    rmSync(TEST_CONFIG_DIR, { recursive: true });
  }
  delete process.env.__TEST_CONFIG_DIR;
}

export function makeTestProvider(name: string, baseUrl: string, opts: {
  format?: string;
  authHeader?: string;
  authFormat?: string;
} = {}) {
  return {
    name,
    display_name: name,
    enabled: true,
    api_keys: { env_var_patterns: [`${name.toUpperCase()}_API_KEY`, `${name.toUpperCase()}_API_KEY_{INDEX}`] },
    endpoints: {
      base_url: baseUrl,
      completions: "/v1/chat/completions",
      compatible_format: opts.format || "openai",
    },
    authentication: {
      header_name: opts.authHeader || "Authorization",
      header_format: opts.authFormat || "Bearer {api_key}",
    },
    request_config: { timeout_seconds: 10 },
    error_handling: {
      "401": { action: "global_key_failure" },
      "429": { action: "model_key_failure" },
    },
  };
}

export function makeTestModel(logicalName: string, routings: Array<{ provider: string; model: string }>) {
  return {
    logical_name: logicalName,
    timeout_seconds: 10,
    default_cooldown_seconds: 5,
    model_routings: routings.map(r => ({ provider: r.provider, model: r.model })),
    fallback_model_routings: [],
  };
}

/** Start a test proxy server (returns the Bun server). */
export function startTestProxy(port?: number): Server {
  const app = createApp();
  return Bun.serve({
    port: port || 0,
    fetch: app.fetch,
  });
}

export { TEST_CONFIG_DIR };
