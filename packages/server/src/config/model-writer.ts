import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ModelRoutingConfigSchema,
  type ModelRoutingConfig,
} from "@model-proxy/contracts/schemas/routing.ts";
import { modelConfigLoader } from "./model-loader.ts";
import { getConfigSearchPaths, getWritableConfigDir } from "./paths.ts";

/** Writable destination for model JSON. Created on first use. */
function modelsRoot(): string {
  const root = getWritableConfigDir();
  const dir = join(root, "models");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Locate an existing model JSON file across all configured search roots. */
function findExistingModelPath(name: string): string | undefined {
  const fileName = `${name}.json`;
  for (const root of getConfigSearchPaths()) {
    const candidate = join(root, "models", fileName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function listModelConfigs(): Array<{
  logical_name: string;
  path: string;
  modified_at: string;
}> {
  const items = new Map<string, { logical_name: string; path: string; modified_at: string }>();

  for (const root of getConfigSearchPaths()) {
    const dir = join(root, "models");
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of entries) {
      if (!file.endsWith(".json")) continue;
      const logical = file.slice(0, -".json".length);
      if (items.has(logical)) continue; // precedence: earlier search path wins
      const full = join(dir, file);
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        items.set(logical, {
          logical_name: logical,
          path: full,
          modified_at: new Date(stat.mtimeMs).toISOString(),
        });
      } catch {
        // ignore
      }
    }
  }

  return [...items.values()].sort((a, b) => a.logical_name.localeCompare(b.logical_name));
}

export function readModelConfig(name: string): ModelRoutingConfig {
  return modelConfigLoader.loadConfig(name, true);
}

export interface WriteOptions {
  overwrite?: boolean;
}

export function writeModelConfig(
  name: string,
  raw: unknown,
  options: WriteOptions = {},
): ModelRoutingConfig {
  const parsed = ModelRoutingConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid model config: ${parsed.error.message}`);
  }
  if (parsed.data.logical_name !== name) {
    throw new Error(
      `logical_name '${parsed.data.logical_name}' must match path '${name}'`,
    );
  }
  const path = join(modelsRoot(), `${name}.json`);
  if (existsSync(path) && options.overwrite !== true) {
    throw new Error(`Model config '${name}' already exists`);
  }
  writeFileSync(path, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
  modelConfigLoader.clearCache();
  return parsed.data;
}

export function patchModelConfig(
  name: string,
  patch: Record<string, unknown>,
): ModelRoutingConfig {
  const existing = readModelConfig(name) as unknown as Record<string, unknown>;
  const merged = { ...existing, ...patch, logical_name: name };
  return writeModelConfig(name, merged, { overwrite: true });
}

export function deleteModelConfig(name: string): boolean {
  const path = findExistingModelPath(name);
  if (path === undefined) return false;
  unlinkSync(path);
  modelConfigLoader.clearCache();
  return true;
}

export function getRawModelConfig(name: string): Record<string, unknown> {
  const path = findExistingModelPath(name);
  if (path === undefined) {
    throw new Error(`Model config '${name}' not found`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
