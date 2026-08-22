import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The single Model-Proxy data directory. Everything the app persists lives
 * under it:
 *
 *   <dataDir>/config/     settings.json, secrets.json, providers/, models/,
 *                         audio-models/, templates/
 *   <dataDir>/storage/    SQLite, completions archive, analytics, metrics
 *
 * Resolution order: `--data-dir` CLI flag (applied via MODEL_PROXY_DATA_DIR),
 * the MODEL_PROXY_DATA_DIR env var, then the platform default
 * (`~/.model-proxy`, or `%LOCALAPPDATA%\model-proxy` on Windows).
 */

let overrideDataDir: string | undefined;

export function getDefaultDataDir(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? process.env.APPDATA;
    if (base !== undefined && base.length > 0) return join(base, "model-proxy");
  }
  return join(homedir(), ".model-proxy");
}

export function getDataDir(): string {
  const fromEnv = process.env.MODEL_PROXY_DATA_DIR;
  const dir = overrideDataDir ?? (fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : undefined) ?? getDefaultDataDir();
  return resolve(dir);
}

export function ensureDataDir(): string {
  const dir = getDataDir();
  mkdirSync(join(dir, "config"), { recursive: true });
  mkdirSync(join(dir, "storage"), { recursive: true });
  return dir;
}

/** Set by the CLI `--data-dir` flag before anything else touches config. */
export function setDataDir(path: string | undefined): void {
  overrideDataDir = path;
}
