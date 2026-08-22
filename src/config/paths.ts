import { existsSync, mkdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolves the set of directories that hold Model-Proxy JSON config
 * (`providers/*.json`, `models/*.json`, `templates/*.json`), plus the single
 * preferred directory for writes.
 */

let primaryConfigDir: string | undefined;
/** When set, `getConfigSearchPaths()` returns only these roots (tests). */
let testSearchPathsOnly: string[] | undefined;

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key = resolve(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export function getPackageConfigDir(): string {
  // .../v2/src/config/paths.ts  ->  .../v2 -> repo root is one up -> /config
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "config");
}

export function getCwdConfigDir(): string {
  return join(process.cwd(), "config");
}

export function getUserConfigDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? process.env.APPDATA;
    if (base) {
      return join(base, "model-proxy", "config");
    }
  }
  return join(homedir(), ".model-proxy", "config");
}

function isWritableDir(path: string, create: boolean): boolean {
  try {
    if (create) {
      mkdirSync(path, { recursive: true });
    }
    if (!existsSync(path)) return false;
    const stat = statSync(path);
    if (!stat.isDirectory()) return false;
    const probe = join(path, ".model_proxy_write_test");
    writeFileSync(probe, "ok", { encoding: "utf8" });
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

export function getWritableConfigDir(): string {
  if (primaryConfigDir !== undefined) return primaryConfigDir;

  const cwd = getCwdConfigDir();
  if (isWritableDir(cwd, false)) {
    primaryConfigDir = cwd;
    return cwd;
  }

  const userConfig = getUserConfigDir();
  if (isWritableDir(userConfig, true)) {
    primaryConfigDir = userConfig;
    return userConfig;
  }

  // Last resort: whichever existed, even if read-only.
  if (existsSync(cwd)) {
    primaryConfigDir = cwd;
    return cwd;
  }

  primaryConfigDir = userConfig;
  return userConfig;
}

/**
 * Reset memoization. Exposed for tests.
 */
export function resetConfigPathCache(): void {
  primaryConfigDir = undefined;
  testSearchPathsOnly = undefined;
}

/** Force the writable config dir to a specific path. Tests only. */
export function setPrimaryConfigDirForTests(path: string | undefined): void {
  primaryConfigDir = path;
  testSearchPathsOnly = path !== undefined ? [path] : undefined;
}

export function getConfigSearchPaths(): string[] {
  if (testSearchPathsOnly !== undefined) {
    return uniquePaths(testSearchPathsOnly);
  }
  const primary = getWritableConfigDir();
  return uniquePaths([
    primary,
    getCwdConfigDir(),
    getUserConfigDir(),
    getPackageConfigDir(),
  ]);
}

export function findConfigFile(relativePath: string): string | undefined {
  for (const root of getConfigSearchPaths()) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
