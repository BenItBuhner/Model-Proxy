import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { getDataDir } from "../config/data-dir.ts";

let testStorageRoot: string | undefined;

export function getStorageRoot(): string {
  if (testStorageRoot !== undefined) return resolve(testStorageRoot);
  const fromEnv = process.env.MODEL_PROXY_STORAGE_DIR;
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  // Older installs (and the Docker volume layout) kept storage at
  // <cwd>/.storage; keep honoring it when present.
  const legacy = join(process.cwd(), ".storage");
  if (existsSync(legacy)) return resolve(legacy);
  return resolve(join(getDataDir(), "storage"));
}

export function getStorageDir(...parts: string[]): string {
  const dir = join(getStorageRoot(), ...parts);
  try {
    // Idempotent: no-op when the directory already exists.
    mkdirSync(dir, { recursive: true });
  } catch {
    // Surface failures on first write instead.
  }
  return dir;
}

export function setStorageRootForTests(path: string | undefined): void {
  testStorageRoot = path;
}
