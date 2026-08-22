import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getDataDir } from "./data-dir.ts";

/**
 * Config lives in exactly one writable root: `<dataDir>/config` (see
 * `data-dir.ts`). The read path adds a single read-only fallback — the config
 * directory shipped with the package (sample providers + templates) — so a
 * fresh install can scaffold new providers without copying files around.
 */

let testConfigDir: string | undefined;

export function getPackageConfigDir(): string {
  // packages/server/src/config/paths.ts -> repo root is four up -> /config
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..", "config");
}

/** The single writable config root: `<dataDir>/config`. */
export function getWritableConfigDir(): string {
  if (testConfigDir !== undefined) return testConfigDir;
  const dir = join(getDataDir(), "config");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Surface failures on first write instead.
  }
  return dir;
}

/** Reset overrides. Exposed for tests. */
export function resetConfigPathCache(): void {
  testConfigDir = undefined;
}

/** Force the config root to a specific path. Tests only. */
export function setPrimaryConfigDirForTests(path: string | undefined): void {
  testConfigDir = path;
}

/**
 * Read roots in priority order: the writable root, then the read-only
 * package config (shipped samples + templates). When a test override is set,
 * only the override is searched so tests stay hermetic.
 */
export function getConfigSearchPaths(): string[] {
  if (testConfigDir !== undefined) return [resolve(testConfigDir)];
  const primary = resolve(getWritableConfigDir());
  const packaged = resolve(getPackageConfigDir());
  return primary === packaged ? [primary] : [primary, packaged];
}

export function findConfigFile(relativePath: string): string | undefined {
  for (const root of getConfigSearchPaths()) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
