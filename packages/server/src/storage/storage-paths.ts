import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

let testStorageRoot: string | undefined;

export function getStorageRoot(): string {
  return resolve(testStorageRoot ?? process.env.MODEL_PROXY_STORAGE_DIR ?? join(process.cwd(), ".storage"));
}

export function getStorageDir(...parts: string[]): string {
  const dir = join(getStorageRoot(), ...parts);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function setStorageRootForTests(path: string | undefined): void {
  testStorageRoot = path;
}
