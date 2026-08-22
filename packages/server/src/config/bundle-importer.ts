import { join } from "node:path";

import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@model-proxy/contracts/schemas/provider.ts";
import {
  ModelRoutingConfigSchema,
  type ModelRoutingConfig,
} from "@model-proxy/contracts/schemas/routing.ts";
import {
  ConfigBundleSchema,
  type BundleDiff,
  type BundleNormalization,
  type BundleSectionDiff,
  type ConfigBundle,
  type ImportOptions,
  type ImportReport,
} from "@model-proxy/contracts/schemas/config-bundle.ts";
import { createLogger } from "../observability/logger.ts";
import {
  getRawProviderConfig,
  listProviderConfigs,
  writeProviderConfig,
} from "./provider-writer.ts";
import {
  getRawModelConfig,
  listModelConfigs,
  writeModelConfig,
} from "./model-writer.ts";
import { readEnvFile, resolveEnvPath, writeEnvFile } from "./env-writer.ts";
import { getWritableConfigDir } from "./paths.ts";
import { normalizeModel, normalizeProvider } from "./bundle-normalizer.ts";

const log = createLogger("config.bundle.import");

/**
 * Parse an arbitrary JSON body (already `JSON.parse`d into `unknown`) into
 * a `ConfigBundle`. Throws with a descriptive `Error` on failure.
 */
export function parseBundle(raw: unknown): ConfigBundle {
  const parsed = ConfigBundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid bundle: ${parsed.error.message}`);
  }
  return parsed.data;
}

function defaultSections(opts: ImportOptions | undefined): {
  providers: boolean;
  models: boolean;
  env: boolean;
} {
  const s = opts?.sections ?? {};
  return {
    providers: s.providers !== false,
    models: s.models !== false,
    env: s.env !== false,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface StagedProvider {
  name: string;
  config: ProviderConfig;
  alreadyExists: boolean;
  existingIsSame: boolean;
}

interface StagedModel {
  name: string;
  config: ModelRoutingConfig;
  alreadyExists: boolean;
  existingIsSame: boolean;
}

interface StageOutcome {
  providers: StagedProvider[];
  models: StagedModel[];
  normalizations: BundleNormalization[];
  providerDiff: BundleSectionDiff;
  modelDiff: BundleSectionDiff;
  abortedDueToStrict: boolean;
}

function existingProviderNames(): Set<string> {
  const names = new Set<string>();
  for (const item of listProviderConfigs()) names.add(item.name);
  return names;
}

function existingModelNames(): Set<string> {
  const names = new Set<string>();
  for (const item of listModelConfigs()) names.add(item.logical_name);
  return names;
}

function readExistingProvider(name: string): Record<string, unknown> | undefined {
  try {
    return getRawProviderConfig(name);
  } catch {
    return undefined;
  }
}

function readExistingModel(name: string): Record<string, unknown> | undefined {
  try {
    return getRawModelConfig(name);
  } catch {
    return undefined;
  }
}

/**
 * Phase 1: validate + normalize every provider and model in the bundle.
 * No writes happen here. Returns the full staged state plus a section-level
 * diff ready for preview rendering.
 */
function stageBundle(bundle: ConfigBundle, opts: ImportOptions | undefined): StageOutcome {
  const sections = defaultSections(opts);
  const strict = opts?.strict === true;

  const providers: StagedProvider[] = [];
  const models: StagedModel[] = [];
  const normalizations: BundleNormalization[] = [];

  const providerDiff: BundleSectionDiff = {
    add: [],
    overwrite: [],
    unchanged: [],
    errors: [],
  };
  const modelDiff: BundleSectionDiff = {
    add: [],
    overwrite: [],
    unchanged: [],
    errors: [],
  };

  let abortedDueToStrict = false;

  // ---- providers ---------------------------------------------------------
  if (sections.providers) {
    const existing = existingProviderNames();
    for (const rawProvider of bundle.setup.providers) {
      const nameAttr = rawProvider["name"];
      const name = typeof nameAttr === "string" ? nameAttr : undefined;
      if (name === undefined || name.length === 0) {
        providerDiff.errors.push({
          name: "<missing-name>",
          error: "Provider entry is missing a 'name' field",
        });
        if (strict) {
          abortedDueToStrict = true;
          break;
        }
        continue;
      }

      const { normalized, changes } = normalizeProvider(rawProvider);
      for (const change of changes) normalizations.push(change);

      const parsed = ProviderConfigSchema.safeParse(normalized);
      if (!parsed.success) {
        providerDiff.errors.push({
          name,
          error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
        if (strict) {
          abortedDueToStrict = true;
          break;
        }
        continue;
      }

      const config = parsed.data;
      const alreadyExists = existing.has(name);
      const existingRaw = alreadyExists ? readExistingProvider(name) : undefined;
      const existingIsSame =
        existingRaw !== undefined && sameJson(existingRaw, config);

      if (!alreadyExists) providerDiff.add.push(name);
      else if (existingIsSame) providerDiff.unchanged.push(name);
      else providerDiff.overwrite.push(name);

      providers.push({ name, config, alreadyExists, existingIsSame });
    }
  }

  if (abortedDueToStrict) {
    return {
      providers,
      models,
      normalizations,
      providerDiff,
      modelDiff,
      abortedDueToStrict,
    };
  }

  // ---- models ------------------------------------------------------------
  if (sections.models) {
    const existing = existingModelNames();
    for (const rawModel of bundle.setup.models) {
      const nameAttr = rawModel["logical_name"];
      const name = typeof nameAttr === "string" ? nameAttr : undefined;
      if (name === undefined || name.length === 0) {
        modelDiff.errors.push({
          name: "<missing-logical_name>",
          error: "Model entry is missing a 'logical_name' field",
        });
        if (strict) {
          abortedDueToStrict = true;
          break;
        }
        continue;
      }

      const { normalized, changes } = normalizeModel(rawModel);
      for (const change of changes) normalizations.push(change);

      const parsed = ModelRoutingConfigSchema.safeParse(normalized);
      if (!parsed.success) {
        modelDiff.errors.push({
          name,
          error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        });
        if (strict) {
          abortedDueToStrict = true;
          break;
        }
        continue;
      }

      const config = parsed.data;
      const alreadyExists = existing.has(name);
      const existingRaw = alreadyExists ? readExistingModel(name) : undefined;
      const existingIsSame =
        existingRaw !== undefined && sameJson(existingRaw, config);

      if (!alreadyExists) modelDiff.add.push(name);
      else if (existingIsSame) modelDiff.unchanged.push(name);
      else modelDiff.overwrite.push(name);

      models.push({ name, config, alreadyExists, existingIsSame });
    }
  }

  return {
    providers,
    models,
    normalizations,
    providerDiff,
    modelDiff,
    abortedDueToStrict,
  };
}

/**
 * Compute the env diff. Uses the section flag but never actually writes here.
 */
function computeEnvDiff(
  bundle: ConfigBundle,
  sectionEnabled: boolean,
): BundleDiff["env"] {
  const diff: BundleDiff["env"] = {
    add: [],
    overwrite: [],
    unchanged: [],
    skipped: [],
  };
  const env = bundle.setup.environment ?? {};
  if (!sectionEnabled) {
    for (const key of Object.keys(env)) diff.skipped.push(key);
    return diff;
  }

  const existing = readEnvFile({ includeValues: true });
  const existingMap = new Map<string, string>();
  for (const entry of existing.entries) existingMap.set(entry.key, entry.value);

  for (const [key, value] of Object.entries(env)) {
    if (!existingMap.has(key)) diff.add.push(key);
    else if (existingMap.get(key) === value) diff.unchanged.push(key);
    else diff.overwrite.push(key);
  }
  return diff;
}

/**
 * Dry-run: read current on-disk state, run validation + normalization, and
 * return what *would* be written without touching disk.
 */
export function previewBundle(
  bundle: ConfigBundle,
  opts?: ImportOptions,
): BundleDiff {
  const sections = defaultSections(opts);
  const staged = stageBundle(bundle, opts);
  return {
    providers: staged.providerDiff,
    models: staged.modelDiff,
    env: computeEnvDiff(bundle, sections.env),
    normalizations: staged.normalizations,
    bundle_version: bundle.version,
  };
}

/**
 * Apply the bundle to disk. Two-phase:
 *   1. Validate + normalize everything (no writes, `stageBundle`).
 *   2. If not strict-aborted, write providers, then models, then env.
 *
 * Conflicts: `conflict_policy` controls whether an existing provider/model
 * gets overwritten (default) or skipped.
 */
export function applyBundle(
  bundle: ConfigBundle,
  opts?: ImportOptions,
): ImportReport {
  const sections = defaultSections(opts);
  const conflictPolicy = opts?.conflict_policy ?? "overwrite";
  const staged = stageBundle(bundle, opts);

  const paths = {
    providers_dir: join(getWritableConfigDir(), "providers"),
    models_dir: join(getWritableConfigDir(), "models"),
    env: resolveEnvPath(),
  };

  if (staged.abortedDueToStrict) {
    return {
      providers: staged.providerDiff,
      models: staged.modelDiff,
      env: computeEnvDiff(bundle, sections.env),
      normalizations: staged.normalizations,
      bundle_version: bundle.version,
      applied: { providers: 0, models: 0, env: 0 },
      paths,
      aborted: true,
    };
  }

  let appliedProviders = 0;
  let appliedModels = 0;
  let appliedEnv = 0;

  // Providers
  for (const item of staged.providers) {
    if (item.existingIsSame) continue;
    if (item.alreadyExists && conflictPolicy === "skip") continue;
    try {
      writeProviderConfig(item.name, item.config, { overwrite: true });
      appliedProviders += 1;
    } catch (err) {
      staged.providerDiff.errors.push({
        name: item.name,
        error: (err as Error).message,
      });
    }
  }

  // Models
  for (const item of staged.models) {
    if (item.existingIsSame) continue;
    if (item.alreadyExists && conflictPolicy === "skip") continue;
    try {
      writeModelConfig(item.name, item.config, { overwrite: true });
      appliedModels += 1;
    } catch (err) {
      staged.modelDiff.errors.push({
        name: item.name,
        error: (err as Error).message,
      });
    }
  }

  // Env — merge: existing keys preserved, bundle values overwrite on key collisions.
  let envDiff: BundleDiff["env"];
  if (sections.env) {
    const existing = readEnvFile({ includeValues: true });
    const merged = new Map<string, string>();
    for (const entry of existing.entries) merged.set(entry.key, entry.value);
    for (const [key, value] of Object.entries(bundle.setup.environment ?? {})) {
      merged.set(key, value);
    }
    const mergedEntries = Array.from(merged, ([key, value]) => ({ key, value }));
    const result = writeEnvFile({ entries: mergedEntries });
    appliedEnv = Object.keys(bundle.setup.environment ?? {}).length;
    envDiff = computeEnvDiffFromExisting(bundle, existing.entries);
    log.info("env merged from bundle", {
      path: result.path,
      applied: appliedEnv,
      skipped: result.skipped.length,
    });
  } else {
    envDiff = computeEnvDiff(bundle, false);
  }

  return {
    providers: staged.providerDiff,
    models: staged.modelDiff,
    env: envDiff,
    normalizations: staged.normalizations,
    bundle_version: bundle.version,
    applied: {
      providers: appliedProviders,
      models: appliedModels,
      env: appliedEnv,
    },
    paths,
    aborted: false,
  };
}

// Internal helper — compute env diff against a pre-captured existing snapshot
// (so the post-write report accurately describes what *changed*).
function computeEnvDiffFromExisting(
  bundle: ConfigBundle,
  existingEntries: Array<{ key: string; value: string }>,
): BundleDiff["env"] {
  const diff: BundleDiff["env"] = {
    add: [],
    overwrite: [],
    unchanged: [],
    skipped: [],
  };
  const existingMap = new Map<string, string>();
  for (const entry of existingEntries) existingMap.set(entry.key, entry.value);
  for (const [key, value] of Object.entries(bundle.setup.environment ?? {})) {
    if (!existingMap.has(key)) diff.add.push(key);
    else if (existingMap.get(key) === value) diff.unchanged.push(key);
    else diff.overwrite.push(key);
  }
  return diff;
}
