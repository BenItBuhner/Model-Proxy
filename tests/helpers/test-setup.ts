/**
 * Shared test infrastructure.
 * All integration tests write configs to a single shared temp directory
 * and register it with the config loader ONCE.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { configLoader } from "../../src/routing/config-loader.ts";
import { clearProviderConfigCache } from "../../src/core/provider-config.ts";
import { resetRotationState, resetFailedKeys } from "../../src/core/api-key-manager.ts";
import { setPrimaryConfigDir, resetConfigDirCache } from "../../src/core/config-paths.ts";

export const SHARED_TEST_DIR = join(import.meta.dir, "..", ".shared-test-config");
const providersDir = join(SHARED_TEST_DIR, "providers");
const modelsDir = join(SHARED_TEST_DIR, "models");

let _initialized = false;

export function initTestEnv() {
  if (!_initialized) {
    if (existsSync(SHARED_TEST_DIR)) rmSync(SHARED_TEST_DIR, { recursive: true });
    mkdirSync(providersDir, { recursive: true });
    mkdirSync(modelsDir, { recursive: true });

    // Point BOTH config-paths AND configLoader to the shared test dir
    setPrimaryConfigDir(SHARED_TEST_DIR);
    (configLoader as any).searchPaths = [SHARED_TEST_DIR];
    (configLoader as any)._pathsAreModelDirs = false;
    _initialized = true;
  }
}

export function addTestProvider(name: string, baseUrl: string, opts: {
  format?: string;
  authHeader?: string;
  authFormat?: string;
  errorHandling?: Record<string, any>;
} = {}) {
  initTestEnv();
  writeFileSync(join(providersDir, `${name}.json`), JSON.stringify({
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
    error_handling: opts.errorHandling || {
      "401": { action: "global_key_failure" },
      "429": { action: "model_key_failure" },
      "500": { action: "model_key_failure" },
    },
  }));
  clearProviderConfigCache();
  configLoader.clearCache();
}

export function addTestModel(logicalName: string, routings: Array<{ provider: string; model: string }>, opts: {
  fallbacks?: string[];
} = {}) {
  initTestEnv();
  writeFileSync(join(modelsDir, `${logicalName}.json`), JSON.stringify({
    logical_name: logicalName,
    timeout_seconds: 10,
    default_cooldown_seconds: 2,
    model_routings: routings.map(r => ({ provider: r.provider, model: r.model })),
    fallback_model_routings: opts.fallbacks || [],
  }));
  configLoader.clearCache();
}

export function resetTestState() {
  resetRotationState();
  resetFailedKeys();
  clearProviderConfigCache();
  configLoader.clearCache();
  // Re-apply test paths
  setPrimaryConfigDir(SHARED_TEST_DIR);
  (configLoader as any).searchPaths = [SHARED_TEST_DIR];
  (configLoader as any)._pathsAreModelDirs = false;
}

export function cleanupTestEnv() {
  if (existsSync(SHARED_TEST_DIR)) rmSync(SHARED_TEST_DIR, { recursive: true });
  _initialized = false;
}
