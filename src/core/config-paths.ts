/**
 * Shared configuration path helpers for Model-Proxy.
 * Keeps config discovery consistent across all modules.
 */
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "fs";
import { join, resolve } from "path";

let _primaryConfigDir: string | null = null;

/** Return the packaged config directory (repo root /config). */
export function getPackageConfigDir(): string {
  return resolve(join(import.meta.dir, "..", "..", "config"));
}

/** Return config directory under current working directory. */
export function getCwdConfigDir(): string {
  return join(process.cwd(), "config");
}

/** Return per-user config directory. */
export function getUserConfigDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA || process.env.APPDATA;
    if (base) return join(base, "model-proxy", "config");
  }
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  return join(home, ".model-proxy", "config");
}

function isWritableDir(path: string, create: boolean): boolean {
  try {
    if (create) {
      mkdirSync(path, { recursive: true });
    }
    if (!existsSync(path)) return false;
    const testFile = join(path, ".model_proxy_write_test");
    writeFileSync(testFile, "ok", "utf-8");
    unlinkSync(testFile);
    return true;
  } catch {
    return false;
  }
}

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      result.push(p);
    }
  }
  return result;
}

/** Return config roots in precedence order for reads. */
export function getConfigSearchPaths(): string[] {
  const primary = getWritableConfigDir();
  const roots = [
    primary,
    getCwdConfigDir(),
    getUserConfigDir(),
    getPackageConfigDir(),
  ];
  return uniquePaths(roots);
}

/** Return the preferred config root for writes. */
export function getWritableConfigDir(): string {
  if (_primaryConfigDir !== null) return _primaryConfigDir;

  const cwdConfig = getCwdConfigDir();
  if (isWritableDir(cwdConfig, false)) {
    _primaryConfigDir = cwdConfig;
    return cwdConfig;
  }

  const userConfig = getUserConfigDir();
  if (isWritableDir(userConfig, true)) {
    _primaryConfigDir = userConfig;
    return userConfig;
  }

  if (existsSync(cwdConfig)) {
    _primaryConfigDir = cwdConfig;
    return cwdConfig;
  }

  _primaryConfigDir = userConfig;
  return userConfig;
}

/** Find a config file by searching all config roots in order. */
export function findConfigFile(relativePath: string): string | null {
  for (const root of getConfigSearchPaths()) {
    const candidate = join(root, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/** Reset the cached primary config dir (for testing). */
export function resetConfigDirCache(): void {
  _primaryConfigDir = null;
}
