import { z } from "zod";

/**
 * Schema for the full configuration bundle produced by the Python-era
 * "Export configuration" UI and consumed by the new `/v1/admin/config/import`
 * route.
 *
 * We keep this schema permissive (`.passthrough()` on nested objects) because
 * the importer re-validates each provider / model individually against
 * `ProviderConfigSchema` / `ModelRoutingConfigSchema` after running it through
 * the legacy-value normalizer.
 */
export const BundleApiKeyEntrySchema = z
  .object({
    env_var: z.string().min(1),
    value: z.string(),
  })
  .passthrough();

export const BundleSetupSchema = z
  .object({
    providers: z.array(z.record(z.unknown())).default([]),
    models: z.array(z.record(z.unknown())).default([]),
    environment: z.record(z.string()).default({}),
    api_keys: z.record(z.array(BundleApiKeyEntrySchema)).default({}),
  })
  .passthrough();

export const BundleMetadataSchema = z
  .object({
    total_providers: z.number().int().optional(),
    total_models: z.number().int().optional(),
    total_api_keys: z.number().int().optional(),
    note: z.string().optional(),
  })
  .passthrough();

export const ConfigBundleSchema = z
  .object({
    version: z.string().min(1).default("1.0.0"),
    exported_at: z.string().optional(),
    metadata: BundleMetadataSchema.optional(),
    setup: BundleSetupSchema,
  })
  .passthrough();

export type ConfigBundle = z.infer<typeof ConfigBundleSchema>;
export type BundleSetup = z.infer<typeof BundleSetupSchema>;
export type BundleApiKeyEntry = z.infer<typeof BundleApiKeyEntrySchema>;

// ---------------------------------------------------------------------------
// Import API shapes (mirrored on the client in web/lib/bundle-api.ts).
// ---------------------------------------------------------------------------

export interface ImportSectionsFlags {
  providers?: boolean;
  models?: boolean;
  env?: boolean;
}

export type ImportConflictPolicy = "overwrite" | "skip";

export interface ImportOptions {
  /** What to do when a provider / model already exists on disk. Default: "overwrite". */
  conflict_policy?: ImportConflictPolicy;
  /** Per-section opt-in. Omitted sections default to true (apply everything). */
  sections?: ImportSectionsFlags;
  /** If true, abort the entire apply on the first validation error. Default: false. */
  strict?: boolean;
}

export interface BundleSectionDiff {
  add: string[];
  overwrite: string[];
  unchanged: string[];
  errors: Array<{ name: string; error: string }>;
}

export interface BundleEnvDiff {
  add: string[];
  overwrite: string[];
  unchanged: string[];
  skipped: string[];
}

export interface BundleNormalization {
  kind: "provider" | "model";
  name: string;
  /** Dot-path of the field that was rewritten (e.g. "authentication.type"). */
  path: string;
  from: unknown;
  to: unknown;
}

export interface BundleDiff {
  providers: BundleSectionDiff;
  models: BundleSectionDiff;
  env: BundleEnvDiff;
  normalizations: BundleNormalization[];
  bundle_version: string;
}

export interface ImportReport extends BundleDiff {
  applied: { providers: number; models: number; env: number };
  paths: { providers_dir: string; models_dir: string; env: string };
  aborted: boolean;
}
