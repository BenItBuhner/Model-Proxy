import type { BundleNormalization } from "../../shared/schemas/config-bundle.ts";

/**
 * Pure legacy-value normalization for provider and model objects produced by
 * the Python-era config exporter.
 *
 * Philosophy:
 *   - If the TS Zod enum was expanded to accept a legacy value as-is (e.g.
 *     `authentication.type = "api_key"`), leave it untouched — bundle
 *     fidelity is preserved and the runtime already handles it.
 *   - If a value is truly deprecated (e.g. `error_handling.action = "ignore"`),
 *     map it to the closest current equivalent and emit a `BundleNormalization`
 *     entry so the UI can surface every rewrite to the operator.
 *
 * Every function is pure: the input object is never mutated. A shallow-cloned
 * copy is returned alongside the change log.
 */

/**
 * Deprecated `error_handling.*.action` values. The schema accepts these
 * without error (so round-tripping is safe) but the normalizer rewrites
 * them so the on-disk files match the canonical names used by the runtime
 * router.
 */
const ERROR_ACTION_MAP: Record<string, string> = {
  ignore: "pass_through",
  cooldown: "provider_cooldown",
};

interface NormalizeResult<T> {
  normalized: T;
  changes: BundleNormalization[];
}

function cloneDeep<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

/**
 * Normalize one raw provider record from `bundle.setup.providers[]`.
 * The returned value still needs to be validated with `ProviderConfigSchema`.
 */
export function normalizeProvider(
  raw: Record<string, unknown>,
): NormalizeResult<Record<string, unknown>> {
  const normalized = cloneDeep(raw);
  const changes: BundleNormalization[] = [];
  const name = typeof raw.name === "string" ? raw.name : "<unknown>";

  // error_handling: { "<status>": { action: "...", ... } }
  const errorHandling = normalized.error_handling;
  if (errorHandling !== null && typeof errorHandling === "object") {
    for (const [statusCode, entryRaw] of Object.entries(
      errorHandling as Record<string, unknown>,
    )) {
      if (entryRaw === null || typeof entryRaw !== "object") continue;
      const entry = entryRaw as Record<string, unknown>;
      const action = entry.action;
      if (typeof action !== "string") continue;
      const mapped = ERROR_ACTION_MAP[action];
      if (mapped === undefined) continue;
      entry.action = mapped;
      changes.push({
        kind: "provider",
        name,
        path: `error_handling.${statusCode}.action`,
        from: action,
        to: mapped,
      });
    }
  }

  // Python bundles sometimes attach extra diagnostic fields that the strict
  // inner schemas reject. Passthrough handles those, but we strip one known
  // "junk" field (`provider_notes`) quietly so the on-disk result stays lean.
  if ("provider_notes" in normalized) {
    delete normalized.provider_notes;
  }

  return { normalized, changes };
}

/**
 * Normalize one raw model record from `bundle.setup.models[]`. Currently a
 * no-op because the TS `ModelRoutingConfigSchema` already accepts every
 * field the Python exporter produces; kept as a symmetric hook so future
 * renames can land here without touching the importer.
 */
export function normalizeModel(
  raw: Record<string, unknown>,
): NormalizeResult<Record<string, unknown>> {
  return { normalized: cloneDeep(raw), changes: [] };
}

/** Exposed for tests so the mapping table can be asserted directly. */
export function legacyErrorActionMapping(): Readonly<Record<string, string>> {
  return ERROR_ACTION_MAP;
}
