import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { openCredential, sealCredential } from "../accounts/secret-box.ts";
import { createLogger } from "../observability/logger.ts";
import { getWritableConfigDir } from "./paths.ts";

const log = createLogger("config.store");

/**
 * UI-managed runtime configuration, replacing the old `.env` editor.
 *
 * Two JSON files under `<dataDir>/config/`:
 *   - settings.json  plain key/value settings (host, ports, tuning knobs)
 *   - secrets.json   secret values (API keys, tokens) sealed with AES-256-GCM
 *
 * Values are hydrated into `process.env` at boot so every existing consumer
 * keeps working. Real environment variables set by the operator always win —
 * hydration never overwrites a variable that is already set, which keeps
 * Docker/CI overrides working with zero extra code.
 */

const SETTINGS_FILE = "settings.json";
const SECRETS_FILE = "secrets.json";

const SECRET_KEY_PATTERNS: RegExp[] = [
  /KEY$/i,
  /_KEY_/i,
  /SECRET$/i,
  /TOKEN$/i,
  /PASSWORD$/i,
  /PROXY_\d+$/i,
];

export function isSecretKey(name: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(name));
}

interface SettingsFileShape {
  version: 1;
  settings: Record<string, string>;
}

interface SecretsFileShape {
  version: 1;
  secrets: Record<string, string>;
}

function settingsPath(): string {
  return join(getWritableConfigDir(), SETTINGS_FILE);
}

function secretsPath(): string {
  return join(getWritableConfigDir(), SECRETS_FILE);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (err) {
    log.warn("unreadable config store file; treating as empty", {
      path,
      err: String(err),
    });
    return fallback;
  }
}

function writeJson(path: string, value: unknown, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const options: { encoding: "utf8"; mode?: number } = { encoding: "utf8" };
  if (mode !== undefined) options.mode = mode;
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", options);
}

function readSettingsFile(): Record<string, string> {
  return readJson<SettingsFileShape>(settingsPath(), { version: 1, settings: {} }).settings;
}

function readSecretsFile(): Record<string, string> {
  const sealed = readJson<SecretsFileShape>(secretsPath(), { version: 1, secrets: {} }).secrets;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(sealed)) {
    try {
      const opened = openCredential(value);
      if (opened !== undefined) out[name] = opened;
    } catch (err) {
      log.warn("failed to unseal secret; skipping", { name, err: String(err) });
    }
  }
  return out;
}

function persistSettings(settings: Record<string, string>): void {
  writeJson(settingsPath(), { version: 1, settings } satisfies SettingsFileShape);
}

function persistSecrets(secrets: Record<string, string>): void {
  const sealed: Record<string, string> = {};
  for (const [name, value] of Object.entries(secrets)) {
    const sealedValue = sealCredential(value);
    if (sealedValue !== undefined) sealed[name] = sealedValue;
  }
  writeJson(secretsPath(), { version: 1, secrets: sealed } satisfies SecretsFileShape, 0o600);
}

/** Merged view of every stored value (secrets decrypted). */
export function readConfigValues(): Record<string, string> {
  return { ...readSettingsFile(), ...readSecretsFile() };
}

export interface ConfigEntry {
  key: string;
  value: string;
  masked: boolean;
}

function maskValue(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-4)}`;
}

/** Entries for the admin UI. Secret values are masked unless requested. */
export function listConfigEntries(options: { includeValues?: boolean } = {}): ConfigEntry[] {
  const merged = readConfigValues();
  return Object.entries(merged)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const masked = isSecretKey(key);
      return {
        key,
        value: options.includeValues === true || !masked ? value : maskValue(value),
        masked,
      };
    });
}

const VALID_KEY = /^[A-Z_][A-Z0-9_]*$/;

/**
 * Replace the full stored config with `entries` (the admin editor semantics —
 * same as the old whole-file `.env` write). Empty values delete the key.
 */
export function replaceConfigValues(entries: Array<{ key: string; value: string }>): {
  applied: number;
  skipped: string[];
} {
  const skipped: string[] = [];
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const { key, value } of entries) {
    if (!VALID_KEY.test(key)) {
      skipped.push(key);
      continue;
    }
    if (value.length === 0) continue;
    if (isSecretKey(key)) secrets[key] = value;
    else settings[key] = value;
  }

  const before = readConfigValues();
  persistSettings(settings);
  persistSecrets(secrets);

  // Apply live so key rotation picks up changes immediately.
  const after = { ...settings, ...secrets };
  for (const key of Object.keys(before)) {
    if (!(key in after)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(after)) {
    process.env[key] = value;
  }

  log.info("config store persisted", {
    settings: Object.keys(settings).length,
    secrets: Object.keys(secrets).length,
  });
  return { applied: Object.keys(after).length, skipped };
}

/**
 * Merge `updates` into the store without touching unrelated keys. Keys whose
 * names start with one of `removePrefixes` and are not part of `updates` are
 * deleted (used by proxy discovery to replace the shared proxy pool).
 */
export function upsertConfigValues(
  updates: Record<string, string>,
  options: { removePrefixes?: string[] } = {},
): { applied: number; removed: string[] } {
  const removePrefixes = options.removePrefixes ?? [];
  const settings = readSettingsFile();
  const secrets = readSecretsFile();
  const removed: string[] = [];

  for (const bucket of [settings, secrets]) {
    for (const key of Object.keys(bucket)) {
      if (removePrefixes.some((prefix) => key.startsWith(prefix)) && !(key in updates)) {
        delete bucket[key];
        removed.push(key);
      }
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!VALID_KEY.test(key)) continue;
    delete settings[key];
    delete secrets[key];
    if (value.length === 0) {
      removed.push(key);
      continue;
    }
    if (isSecretKey(key)) secrets[key] = value;
    else settings[key] = value;
  }

  persistSettings(settings);
  persistSecrets(secrets);

  for (const [key, value] of Object.entries(updates)) {
    if (value.length === 0) delete process.env[key];
    else process.env[key] = value;
  }
  for (const key of removed) {
    if (!(key in updates)) delete process.env[key];
  }

  log.info("config store updated in place", {
    applied: Object.keys(updates).length,
    removed: removed.length,
  });
  return { applied: Object.keys(updates).length, removed };
}

/**
 * Hydrate stored values into `process.env`. Called once at boot, before any
 * module reads env-derived constants. Never overwrites variables the operator
 * already set — real environment variables are overrides by design.
 */
export function hydrateProcessEnv(): number {
  let applied = 0;
  for (const [key, value] of Object.entries(readConfigValues())) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied += 1;
  }
  return applied;
}
