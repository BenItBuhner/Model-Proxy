import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createLogger } from "../observability/logger.ts";

const log = createLogger("config.env");

/**
 * Locations to check for the project `.env` file, in priority order. The
 * runtime is container-friendly (`/app/.env`) and falls back to the repo root.
 */
function candidatePaths(): string[] {
  const paths: string[] = [];
  const envPath = process.env.MODEL_PROXY_ENV_FILE;
  if (envPath !== undefined && envPath.length > 0) paths.push(envPath);
  paths.push("/app/.env");
  paths.push(join(process.cwd(), ".env"));
  const seen = new Set<string>();
  return paths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

export function resolveEnvPath(): string {
  const paths = candidatePaths();
  // If an explicit file is set, prefer it even when it doesn't exist yet
  // (writes should create the file at that path).
  const explicit = process.env.MODEL_PROXY_ENV_FILE;
  if (explicit !== undefined && explicit.length > 0) return explicit;

  for (const candidate of paths) {
    if (existsSync(candidate)) return candidate;
  }
  // Prefer cwd on first write rather than `/app/.env` on non-container hosts.
  return join(process.cwd(), ".env");
}

export interface ParsedEnv {
  entries: Array<{ key: string; value: string; masked: boolean }>;
  raw: string;
  path: string;
}

const MASKED_KEY_PATTERNS: RegExp[] = [
  /KEY$/i,
  /_KEY_/i,
  /SECRET$/i,
  /TOKEN$/i,
  /PASSWORD$/i,
];

export function readEnvFile(options: { includeValues?: boolean } = {}): ParsedEnv {
  const path = resolveEnvPath();
  let raw = "";
  if (existsSync(path)) {
    raw = readFileSync(path, "utf8");
  }

  const entries: ParsedEnv["entries"] = [];
  for (const line of raw.split(/\r?\n/)) {
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
    const masked = MASKED_KEY_PATTERNS.some((re) => re.test(key));
    const displayValue = options.includeValues === true || !masked ? value : maskValue(value);
    entries.push({ key, value: displayValue, masked });
  }

  return { entries, raw, path };
}

function maskValue(value: string): string {
  if (value.length <= 4) return "****";
  return `${value.slice(0, 2)}***${value.slice(-4)}`;
}

export interface WriteEnvInput {
  entries: Array<{ key: string; value: string }>;
}

function serializeEnv(entries: WriteEnvInput["entries"]): string {
  const lines: string[] = [];
  lines.push("# Model-Proxy .env");
  lines.push(`# Last updated: ${new Date().toISOString()}`);
  lines.push("");
  for (const { key, value } of entries) {
    const escaped =
      value.includes("\n") || value.includes(" ") || value.includes("\"")
        ? JSON.stringify(value)
        : value;
    lines.push(`${key}=${escaped}`);
  }
  return lines.join("\n") + "\n";
}

export function writeEnvFile(input: WriteEnvInput): {
  path: string;
  applied: number;
  skipped: string[];
} {
  const path = resolveEnvPath();
  const skipped: string[] = [];
  const validEntries: WriteEnvInput["entries"] = [];
  for (const entry of input.entries) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(entry.key)) {
      skipped.push(entry.key);
      continue;
    }
    validEntries.push({ key: entry.key, value: entry.value });
  }

  const serialized = serializeEnv(validEntries);
  writeFileSync(path, serialized, "utf8");
  log.info("env file persisted", { path, count: validEntries.length });

  // Apply to the live process env so key rotation picks up new keys immediately.
  for (const { key, value } of validEntries) {
    if (value.length === 0) delete process.env[key];
    else process.env[key] = value;
  }

  return { path, applied: validEntries.length, skipped };
}
