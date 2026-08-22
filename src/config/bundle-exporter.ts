import type { ConfigBundle } from "../../shared/schemas/config-bundle.ts";
import { matchEnvKeys } from "../providers/env-matcher.ts";
import { readEnvFile } from "./env-writer.ts";
import {
  getRawProviderConfig,
  listProviderConfigs,
} from "./provider-writer.ts";
import {
  getRawModelConfig,
  listModelConfigs,
} from "./model-writer.ts";

/**
 * Compose a configuration bundle from the current on-disk state so another
 * Model-Proxy instance can re-import the file without modification.
 */
export function exportBundle(): ConfigBundle {
  const providerEntries = listProviderConfigs();
  const modelEntries = listModelConfigs();

  const providers: Array<Record<string, unknown>> = [];
  for (const entry of providerEntries) {
    try {
      providers.push(getRawProviderConfig(entry.name));
    } catch {
      // skip unreadable files — they would have failed the admin list anyway.
    }
  }

  const models: Array<Record<string, unknown>> = [];
  for (const entry of modelEntries) {
    try {
      models.push(getRawModelConfig(entry.logical_name));
    } catch {
      // ditto
    }
  }

  // .env contents (unmasked) — includes API keys + meta vars.
  const parsedEnv = readEnvFile({ includeValues: true });
  const environment: Record<string, string> = {};
  for (const entry of parsedEnv.entries) {
    environment[entry.key] = entry.value;
  }

  // Per-provider api_keys grouping, derived from the flat env dict.
  const apiKeys: Record<string, Array<{ env_var: string; value: string }>> = {};
  let totalApiKeys = 0;
  for (const provider of providers) {
    const providerName =
      typeof provider.name === "string" ? provider.name : undefined;
    if (providerName === undefined) continue;
    const apiKeysCfg = (provider.api_keys as
      | { env_var_patterns?: unknown }
      | undefined) ?? {};
    const patterns = Array.isArray(apiKeysCfg.env_var_patterns)
      ? (apiKeysCfg.env_var_patterns as string[])
      : [];
    if (patterns.length === 0) continue;
    const matches = matchEnvKeys(patterns, providerName, environment);
    if (matches.length === 0) continue;
    const group: Array<{ env_var: string; value: string }> = [];
    for (const match of matches) {
      const value = environment[match.envVar];
      if (value === undefined || value.length === 0) continue;
      group.push({ env_var: match.envVar, value });
      totalApiKeys += 1;
    }
    if (group.length > 0) apiKeys[providerName] = group;
  }

  const bundle: ConfigBundle = {
    version: "1.0.0",
    exported_at: new Date().toISOString(),
    metadata: {
      total_providers: providers.length,
      total_models: models.length,
      total_api_keys: totalApiKeys,
      note: "Full configuration export including all API keys. Store securely!",
    },
    setup: {
      providers,
      models,
      environment,
      api_keys: apiKeys,
    },
  };

  return bundle;
}
