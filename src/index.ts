/**
 * Model-Proxy entry point.
 * Starts the Hono server on Bun.
 */
import { createApp } from "./app.ts";
import { env } from "./core/env.ts";
import { getAllProviderConfigs, isProviderEnabled } from "./core/provider-config.ts";
import { getAvailableKeys } from "./core/api-key-manager.ts";
import { configLoader } from "./routing/config-loader.ts";

// ── Startup Banner ────────────────────────────────────────────────
function printStartupBanner() {
  console.log("\n============================================");
  console.log("  Model-Proxy v1.0.0 (Bun + Hono + TypeScript)");
  console.log("============================================\n");

  // Print provider key counts
  try {
    const configs = getAllProviderConfigs();
    let printed = false;
    const sortedNames = [...configs.keys()].sort();

    for (const name of sortedNames) {
      if (!isProviderEnabled(name)) continue;
      const keyCount = getAvailableKeys(name).length;
      if (keyCount === 0) continue;
      if (!printed) { console.log("Provider API keys:"); printed = true; }
      console.log(`  - ${name}: ${keyCount}`);
    }
    if (!printed) console.log("Provider API keys: none configured");
  } catch (e) {
    console.log(`Provider API keys: error loading (${e})`);
  }

  // Print model count
  try {
    const models = configLoader.getAvailableModels();
    console.log(`Models configured: ${models.length}`);
    if (models.length > 0 && models.length <= 20) {
      console.log(`  ${models.join(", ")}`);
    }
  } catch {
    console.log("Models configured: error loading");
  }

  console.log();
}

// ── Startup Validation ────────────────────────────────────────────
function validateStartup() {
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check client API key
  if (!env.CLIENT_API_KEY) {
    if (env.REQUIRE_CLIENT_API_KEY) {
      errors.push("CLIENT_API_KEY is required but not set");
    } else {
      warnings.push("CLIENT_API_KEY not set - authentication is disabled");
    }
  }

  // Check providers
  try {
    const configs = getAllProviderConfigs();
    if (configs.size === 0) {
      warnings.push("No provider configurations found");
    } else {
      let hasKeys = false;
      for (const [name] of configs) {
        if (isProviderEnabled(name) && getAvailableKeys(name).length > 0) {
          hasKeys = true;
          break;
        }
      }
      if (!hasKeys) warnings.push("No providers have API keys configured");
    }
  } catch (e) {
    errors.push(`Failed to load provider configs: ${e}`);
  }

  // Check models
  try {
    const models = configLoader.getAvailableModels();
    if (models.length === 0) warnings.push("No models configured");
  } catch (e) {
    errors.push(`Failed to load model configs: ${e}`);
  }

  for (const w of warnings) console.log(`Warning: ${w}`);
  for (const e of errors) console.error(`Error: ${e}`);

  if (errors.length > 0 && env.FAIL_ON_STARTUP_VALIDATION) {
    throw new Error(`Startup validation failed:\n${errors.map(e => `  - ${e}`).join("\n")}`);
  }
}

// ── Start Server ──────────────────────────────────────────────────
printStartupBanner();
validateStartup();

const app = createApp();
const port = env.PORT;
const host = env.HOST;

console.log(`Server starting on http://${host}:${port}`);
console.log(`Setup UI available at http://${host}:${port}/setup`);
console.log();

export default {
  port,
  hostname: host,
  fetch: app.fetch,
};
