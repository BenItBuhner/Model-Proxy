/**
 * Provider configuration loader and manager.
 * Loads provider configurations from JSON files and provides access to settings.
 */
import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import type { ProviderConfig } from "../types/provider-config.ts";
import { findConfigFile, getConfigSearchPaths, getPackageConfigDir } from "./config-paths.ts";

// Cache for loaded provider configs
const _providerConfigs: Map<string, ProviderConfig> = new Map();

function getProviderConfigPath(providerName: string): string | null {
  const relativePath = join("providers", `${providerName}.json`);
  const found = findConfigFile(relativePath);
  if (found) return found;
  // Fallback to package config dir
  const fallback = join(getPackageConfigDir(), relativePath);
  return existsSync(fallback) ? fallback : null;
}

export function loadProviderConfig(providerName: string): ProviderConfig {
  const configPath = getProviderConfigPath(providerName);
  if (!configPath) {
    throw new Error(`Provider config not found: ${providerName}`);
  }

  const raw = readFileSync(configPath, "utf-8");
  const config = JSON.parse(raw) as ProviderConfig;

  // Validate required fields
  const required = ["name", "enabled", "endpoints", "authentication"];
  for (const field of required) {
    if (!(field in config)) {
      throw new Error(`Provider config missing required field: ${field}`);
    }
  }
  if (!config.endpoints.base_url) {
    throw new Error("Provider config missing base_url in endpoints");
  }

  _providerConfigs.set(providerName, config);
  return config;
}

export function getAllProviderConfigs(): Map<string, ProviderConfig> {
  const configs = new Map<string, ProviderConfig>();
  const seen = new Set<string>();

  for (const root of getConfigSearchPaths()) {
    const providersDir = join(root, "providers");
    if (!existsSync(providersDir)) continue;

    let files: string[];
    try {
      files = readdirSync(providersDir);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const providerName = file.replace(".json", "");
      if (seen.has(providerName)) continue;
      seen.add(providerName);

      try {
        configs.set(providerName, loadProviderConfig(providerName));
      } catch (e) {
        console.warn(`Warning: Failed to load config for ${providerName}: ${e}`);
      }
    }
  }

  return configs;
}

export function getProviderConfig(providerName: string): ProviderConfig | null {
  if (_providerConfigs.has(providerName)) {
    return _providerConfigs.get(providerName)!;
  }
  try {
    return loadProviderConfig(providerName);
  } catch {
    return null;
  }
}

export function reloadProviderConfig(providerName: string): ProviderConfig {
  _providerConfigs.delete(providerName);
  return loadProviderConfig(providerName);
}

function substituteEnvVars(text: string): string {
  return text.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return process.env[varName] ?? match;
  });
}

export function getProviderEndpoint(
  providerName: string,
  endpointType: string = "completions"
): string {
  const config = getProviderConfig(providerName);
  if (!config) throw new Error(`Provider config not found: ${providerName}`);

  const endpoints = config.endpoints;
  let baseUrl = substituteEnvVars(endpoints.base_url);

  // Check for proxy override
  if (config.proxy_support?.enabled && config.proxy_support.base_url_override) {
    baseUrl = substituteEnvVars(config.proxy_support.base_url_override);
  }

  let endpointPath = "";
  if (endpointType === "streaming") {
    endpointPath = endpoints.streaming || endpoints.completions || "";
  } else {
    endpointPath = endpoints.completions || "";
  }

  if (endpointPath.startsWith("/")) endpointPath = endpointPath.slice(1);
  if (baseUrl.endsWith("/")) return `${baseUrl}${endpointPath}`;
  return `${baseUrl}/${endpointPath}`;
}

export function getProviderAuthHeaders(
  providerName: string,
  apiKey: string
): Record<string, string> {
  const config = getProviderConfig(providerName);
  if (!config) throw new Error(`Provider config not found: ${providerName}`);

  const authConfig = config.authentication;
  const headers: Record<string, string> = {};

  const headerValue = authConfig.header_format.replace("{api_key}", apiKey);
  headers[authConfig.header_name] = headerValue;

  if (authConfig.additional_headers) {
    for (const [key, value] of Object.entries(authConfig.additional_headers)) {
      headers[key] = substituteEnvVars(String(value));
    }
  }

  return headers;
}

export function getProviderEnvVarPatterns(providerName: string): string[] {
  const config = getProviderConfig(providerName);
  if (!config) return [];

  const apiKeysConfig = config.api_keys;
  if (!apiKeysConfig) return [];

  const patterns = apiKeysConfig.env_var_patterns || [];
  const providerUpper = providerName.toUpperCase().replace(/-/g, "_");

  return patterns.map((p) => p.replace(/\{PROVIDER\}/g, providerUpper));
}

export function getProviderWireProtocol(providerName: string): "openai" | "anthropic" {
  const config = getProviderConfig(providerName);
  if (!config) return "openai";

  const compatibleFormat = config.endpoints.compatible_format;
  if (!compatibleFormat) return "openai";

  const normalized = String(compatibleFormat).trim().toLowerCase();
  const mapping: Record<string, "openai" | "anthropic"> = {
    openai: "openai",
    anthropic: "anthropic",
    azure: "openai",
    native: "openai",
  };
  return mapping[normalized] || "openai";
}

export function isProviderEnabled(providerName: string): boolean {
  const config = getProviderConfig(providerName);
  if (!config) return false;
  return config.enabled !== false;
}

export function clearProviderConfigCache(): void {
  _providerConfigs.clear();
}
