import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@model-proxy/contracts/schemas/provider.ts";
import { providerConfigLoader } from "./provider-loader.ts";
import { getConfigSearchPaths, getWritableConfigDir } from "./paths.ts";

function providersRoot(): string {
  const root = getWritableConfigDir();
  const dir = join(root, "providers");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function findExistingProviderPath(name: string): string | undefined {
  const fileName = `${name}.json`;
  for (const root of getConfigSearchPaths()) {
    const candidate = join(root, "providers", fileName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function listProviderConfigs(): Array<{
  name: string;
  path: string;
  modified_at: string;
  enabled: boolean;
}> {
  const items = new Map<string, { name: string; path: string; modified_at: string; enabled: boolean }>();

  for (const root of getConfigSearchPaths()) {
    const dir = join(root, "providers");
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -".json".length);
      if (items.has(name)) continue;
      const full = join(dir, file);
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        let enabled = true;
        try {
          const cfg = providerConfigLoader.loadProvider(name);
          enabled = cfg.enabled;
        } catch {
          enabled = false;
        }
        items.set(name, {
          name,
          path: full,
          modified_at: new Date(stat.mtimeMs).toISOString(),
          enabled,
        });
      } catch {
        // ignore
      }
    }
  }

  return [...items.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function readProviderConfig(name: string): ProviderConfig {
  return providerConfigLoader.loadProvider(name, true);
}

export function getRawProviderConfig(name: string): Record<string, unknown> {
  const path = findExistingProviderPath(name);
  if (path === undefined) {
    throw new Error(`Provider config '${name}' not found`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function writeProviderConfig(
  name: string,
  raw: unknown,
  options: { overwrite?: boolean } = {},
): ProviderConfig {
  const parsed = ProviderConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid provider config: ${parsed.error.message}`);
  }
  if (parsed.data.name !== name) {
    throw new Error(
      `provider name '${parsed.data.name}' must match path '${name}'`,
    );
  }
  const path = join(providersRoot(), `${name}.json`);
  if (existsSync(path) && options.overwrite !== true) {
    throw new Error(`Provider config '${name}' already exists`);
  }
  writeFileSync(path, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
  providerConfigLoader.clearCache();
  return parsed.data;
}

export function patchProviderConfig(
  name: string,
  patch: Record<string, unknown>,
): ProviderConfig {
  const existing = getRawProviderConfig(name);
  const merged = { ...existing, ...patch, name };
  return writeProviderConfig(name, merged, { overwrite: true });
}

export function deleteProviderConfig(name: string): boolean {
  const path = findExistingProviderPath(name);
  if (path === undefined) return false;
  unlinkSync(path);
  providerConfigLoader.clearCache();
  return true;
}
