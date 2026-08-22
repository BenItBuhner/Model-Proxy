import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  applyBundle,
  parseBundle,
  previewBundle,
} from "../src/config/bundle-importer.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";

const fixturePath = join(import.meta.dir, "fixtures", "bundle-sample.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

const tmpRoot = join(tmpdir(), `mp-v2-bundle-${process.pid}-${Date.now()}`);

mkdirSync(join(tmpRoot, "providers"), { recursive: true });
mkdirSync(join(tmpRoot, "models"), { recursive: true });

setPrimaryConfigDirForTests(tmpRoot);
(modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
(modelConfigLoader as unknown as { pathsArePlainModelDirs: boolean }).pathsArePlainModelDirs = false;
(providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];

beforeAll(() => {
  process.env.MODEL_PROXY_ENV_FILE = join(tmpRoot, ".env");
});

afterAll(() => {
  delete process.env.MODEL_PROXY_ENV_FILE;
  setPrimaryConfigDirForTests(undefined);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // Windows file-lock tolerance.
  }
});

function cloneFixture(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(fixture)) as Record<string, unknown>;
}

describe("bundle-importer (real python-era fixture)", () => {
  test("parseBundle accepts the raw fixture", () => {
    const bundle = parseBundle(cloneFixture());
    expect(bundle.version).toBe("1.0.0");
    expect(bundle.setup.providers.length).toBeGreaterThan(0);
    expect(bundle.setup.models.length).toBeGreaterThan(0);
    expect(Object.keys(bundle.setup.environment).length).toBeGreaterThan(0);
  });

  test("previewBundle has zero hard errors and every entry is accounted for", () => {
    const bundle = parseBundle(cloneFixture());
    const diff = previewBundle(bundle);
    expect(diff.providers.errors).toEqual([]);
    expect(diff.models.errors).toEqual([]);
    // Every provider / model from the bundle must land in some column of the diff
    // (add OR overwrite OR unchanged). Some may already exist in the repo's
    // packaged config/ dir, which is expected.
    const providerTotal =
      diff.providers.add.length +
      diff.providers.overwrite.length +
      diff.providers.unchanged.length;
    expect(providerTotal).toBe(bundle.setup.providers.length);
    const modelTotal =
      diff.models.add.length +
      diff.models.overwrite.length +
      diff.models.unchanged.length;
    expect(modelTotal).toBe(bundle.setup.models.length);
    // Environment has no existing file on first run -> everything adds.
    expect(diff.env.add.length).toBe(Object.keys(bundle.setup.environment).length);
    expect(diff.env.overwrite.length).toBe(0);
    // Sample has local-llama ignore/cooldown actions -> at least two normalizations.
    expect(diff.normalizations.length).toBeGreaterThanOrEqual(2);
    expect(
      diff.normalizations.some((n) => n.path === "error_handling.401.action"),
    ).toBe(true);
  });

  test("applyBundle writes every new / changed provider + model + all env keys", () => {
    const bundle = parseBundle(cloneFixture());
    const preview = previewBundle(bundle);
    const expectedProviders =
      preview.providers.add.length + preview.providers.overwrite.length;
    const expectedModels =
      preview.models.add.length + preview.models.overwrite.length;

    const report = applyBundle(bundle);
    expect(report.aborted).toBe(false);
    expect(report.applied.providers).toBe(expectedProviders);
    expect(report.applied.models).toBe(expectedModels);
    expect(report.applied.env).toBe(Object.keys(bundle.setup.environment).length);

    // Spot-check a few files landed on disk in the tmp writable dir.
    expect(existsSync(join(tmpRoot, "providers", "gemini.json"))).toBe(true);
    expect(existsSync(join(tmpRoot, "providers", "nahcrof.json"))).toBe(true);
    expect(existsSync(join(tmpRoot, "models", "turbo.json"))).toBe(true);
    expect(existsSync(join(tmpRoot, ".env"))).toBe(true);

    const envText = readFileSync(join(tmpRoot, ".env"), "utf8");
    expect(envText).toContain("CLIENT_API_KEY");
    expect(envText).toContain("GEMINI_API_KEY_1");

    // Local-llama on disk should have the normalized "pass_through" action.
    const localLlama = JSON.parse(
      readFileSync(join(tmpRoot, "providers", "local-llama.json"), "utf8"),
    ) as { error_handling: Record<string, { action: string }> };
    expect(localLlama.error_handling["401"]!.action).toBe("pass_through");
    expect(localLlama.error_handling["429"]!.action).toBe("provider_cooldown");
  });

  test("second applyBundle with same data is a no-op (everything unchanged)", () => {
    const bundle = parseBundle(cloneFixture());
    const report = applyBundle(bundle);
    expect(report.aborted).toBe(false);
    expect(report.applied.providers).toBe(0);
    expect(report.applied.models).toBe(0);
    expect(report.providers.unchanged.length).toBe(bundle.setup.providers.length);
    expect(report.models.unchanged.length).toBe(bundle.setup.models.length);
  });

  test("conflict_policy=skip leaves existing providers untouched", () => {
    const bundle = parseBundle(cloneFixture());
    // Tweak one provider in-place and try to re-apply with skip -> must not overwrite.
    const providers = bundle.setup.providers as Array<Record<string, unknown>>;
    const target = providers.find((p) => p.name === "gemini");
    expect(target).toBeDefined();
    (target as Record<string, unknown>).display_name = "Gemini (modified)";

    const report = applyBundle(bundle, { conflict_policy: "skip" });
    expect(report.aborted).toBe(false);
    expect(report.applied.providers).toBe(0); // all existing -> skipped.

    const onDisk = JSON.parse(
      readFileSync(join(tmpRoot, "providers", "gemini.json"), "utf8"),
    ) as { display_name: string };
    expect(onDisk.display_name).toBe("Gemini");
  });

  test("sections.env=false does not touch the env file", () => {
    const envSnapshot = readFileSync(join(tmpRoot, ".env"), "utf8");
    const bundle = parseBundle(cloneFixture());
    // Inject a fresh env key that would *otherwise* land on disk.
    bundle.setup.environment["NEW_SENTINEL_KEY"] = "should-not-appear";
    const report = applyBundle(bundle, {
      sections: { providers: false, models: false, env: false },
    });
    expect(report.applied.env).toBe(0);
    const after = readFileSync(join(tmpRoot, ".env"), "utf8");
    expect(after).toBe(envSnapshot);
    expect(after.includes("NEW_SENTINEL_KEY")).toBe(false);
  });

  test("strict mode aborts the whole apply when a provider fails validation", () => {
    const bundle = parseBundle(cloneFixture());
    // Force a validation failure on one provider.
    const providers = bundle.setup.providers as Array<Record<string, unknown>>;
    (providers[0] as Record<string, unknown>).endpoints = { base_url: "not-a-url" };

    const report = applyBundle(bundle, { strict: true });
    expect(report.aborted).toBe(true);
    expect(report.applied.providers).toBe(0);
    expect(report.applied.models).toBe(0);
  });
});
