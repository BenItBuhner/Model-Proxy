import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { createLogger } from "../observability/logger.ts";
import {
  hydrateProcessEnv,
  readConfigValues,
  upsertConfigValues,
} from "./config-store.ts";
import { ensureDataDir } from "./data-dir.ts";
import { getPackageConfigDir, getWritableConfigDir } from "./paths.ts";

const log = createLogger("config.bootstrap");

const ENV_MIGRATION_MARKER = ".migrated-env";
const CONFIG_SUBDIRS = ["providers", "models", "audio-models", "templates"] as const;

/**
 * One-time process bootstrap. Must run before the Hono app (and anything
 * that reads env-derived constants at module load) is imported.
 *
 *   1. Ensure the data directory exists.
 *   2. Migrate legacy state (`.env` rows, loose `config/` JSONs) into the
 *      config store on first boot so existing installs survive unchanged.
 *   3. Hydrate stored settings + secrets into `process.env` (operator env
 *      vars always win).
 *   4. Generate and persist an admin `CLIENT_API_KEY` when none is
 *      configured anywhere, and print it once to the console.
 */
export function bootstrapConfig(): void {
  ensureDataDir();
  migrateLegacyEnvFile();
  migrateLegacyConfigDir();
  const hydrated = hydrateProcessEnv();
  if (hydrated > 0) log.info("hydrated stored config into process env", { count: hydrated });
  ensureAdminKey();
}

function legacyEnvPath(): string | undefined {
  const explicit = process.env.MODEL_PROXY_ENV_FILE;
  const candidates = [
    ...(explicit !== undefined && explicit.length > 0 ? [explicit] : []),
    "/app/.env",
    join(process.cwd(), ".env"),
  ];
  return candidates.find((p) => existsSync(p));
}

/** Import legacy `.env` rows into the config store exactly once. */
function migrateLegacyEnvFile(): void {
  const configRoot = getWritableConfigDir();
  const marker = join(configRoot, ENV_MIGRATION_MARKER);
  if (existsSync(marker)) return;

  const envPath = legacyEnvPath();
  if (envPath === undefined) return;

  const stored = readConfigValues();
  const updates: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (value.length === 0) continue;
    if (stored[key] !== undefined) continue;
    updates[key] = value;
  }

  if (Object.keys(updates).length > 0) {
    upsertConfigValues(updates);
    log.info("migrated legacy .env into the config store", {
      from: envPath,
      keys: Object.keys(updates).length,
    });
  }
  writeFileSync(marker, `${new Date().toISOString()} ${envPath}\n`, "utf8");
}

/**
 * Copy loose provider/model JSONs from a legacy `<cwd>/config` directory into
 * the data dir (skipping anything that already exists there). The packaged
 * config dir is already on the read path, so it is never copied.
 */
function migrateLegacyConfigDir(): void {
  const configRoot = getWritableConfigDir();
  const legacyRoot = join(process.cwd(), "config");
  if (!existsSync(legacyRoot)) return;
  if (samePath(legacyRoot, configRoot) || samePath(legacyRoot, getPackageConfigDir())) return;

  let copied = 0;
  for (const subdir of CONFIG_SUBDIRS) {
    const from = join(legacyRoot, subdir);
    if (!existsSync(from)) continue;
    const to = join(configRoot, subdir);
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      if (!entry.endsWith(".json")) continue;
      const target = join(to, entry);
      if (existsSync(target)) continue;
      try {
        copyFileSync(join(from, entry), target);
        copied += 1;
      } catch (err) {
        log.warn("failed to copy legacy config file", { entry, err: String(err) });
      }
    }
  }
  if (copied > 0) {
    log.info("migrated legacy config JSONs into the data dir", { from: legacyRoot, copied });
  }
}

function samePath(a: string, b: string): boolean {
  return join(a, ".") === join(b, ".");
}

/**
 * A fresh install has no client key anywhere. Generate one, persist it in the
 * secrets store, and print it once so the operator can log in — no `.env`
 * required, ever.
 */
function ensureAdminKey(): void {
  const existing = process.env.CLIENT_API_KEY;
  if (existing !== undefined && existing.trim().length > 0) return;

  const key = `mp_${randomBytes(24).toString("base64url")}`;
  upsertConfigValues({ CLIENT_API_KEY: key });

  // Deliberately console.log (not the structured logger): this is the one
  // first-run message the operator must see to get into the admin UI.
  console.log("");
  console.log("========================================================");
  console.log("  Model-Proxy generated an admin API key for this install");
  console.log(`  CLIENT_API_KEY: ${key}`);
  console.log("  Open the admin UI and log in with it. Manage keys from");
  console.log("  the UI afterwards — no .env file is required.");
  console.log("========================================================");
  console.log("");
  log.info("generated admin CLIENT_API_KEY on first boot");
}
