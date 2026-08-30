import { rmWithRetry } from "./support.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { applyBundle, parseBundle } from "../src/config/bundle-importer.ts";
import { exportBundle } from "../src/config/bundle-exporter.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const fixturePath = join(import.meta.dir, "fixtures", "bundle-sample.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

const tmpRoot = join(tmpdir(), `mp-v2-bundle-export-${process.pid}-${Date.now()}`);

mkdirSync(join(tmpRoot, "providers"), { recursive: true });
mkdirSync(join(tmpRoot, "models"), { recursive: true });

setPrimaryConfigDirForTests(tmpRoot);



beforeAll(() => {
  setStorageRootForTests(join(tmpRoot, ".storage"));
});

afterAll(() => {
  setStorageRootForTests(undefined);
  setPrimaryConfigDirForTests(undefined);
  try {
    rmWithRetry(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows tolerance.
  }
});

describe("bundle-exporter round trip", () => {
  test("import -> export -> re-import reaches a fixed point", () => {
    const initial = parseBundle(JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>);
    applyBundle(initial);

    const exported = exportBundle();
    expect(exported.version).toBe("1.0.0");
    const exportedProviderNames = new Set(
      exported.setup.providers.map((provider) => provider["name"]),
    );
    const exportedModelNames = new Set(
      exported.setup.models.map((model) => model["logical_name"]),
    );
    for (const provider of initial.setup.providers) {
      expect(exportedProviderNames.has(provider["name"])).toBe(true);
    }
    for (const model of initial.setup.models) {
      expect(exportedModelNames.has(model["logical_name"])).toBe(true);
    }

    // Every env key from the initial bundle must be present in the export.
    for (const key of Object.keys(initial.setup.environment)) {
      expect(exported.setup.environment[key]).toBe(initial.setup.environment[key]);
    }

    // Per-provider api_keys grouping should find the same gemini keys.
    const geminiKeys = exported.setup.api_keys["gemini"] ?? [];
    expect(geminiKeys.length).toBeGreaterThan(0);
    for (const entry of geminiKeys) {
      expect(entry.env_var.startsWith("GEMINI_API_KEY")).toBe(true);
    }

    // Re-importing the export is a no-op.
    const report = applyBundle(exportBundle());
    expect(report.applied.providers).toBe(0);
    expect(report.applied.models).toBe(0);
  });
});
