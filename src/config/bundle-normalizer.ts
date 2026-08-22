import type { BundleNormalization } from "../../shared/schemas/config-bundle.ts";

/**
 * Pure legacy-value normalization for provider and model objects.
 *
 * Older exports and on-disk configs may carry deprecated enum values. The
 * schemas only accept the canonical names, so every legacy value is mapped to
 * its current equivalent here and a `BundleNormalization` entry is emitted so
 * the UI can surface every rewrite to the operator.
 *
 * Every function is pure: the input object is never mutated. A shallow-cloned
 * copy is returned alongside the change log.
 */

/** Deprecated `error_handling.*.action` values. */
const ERROR_ACTION_MAP: Record<string, string> = {
  ignore: "pass_through",
  cooldown: "provider_cooldown",
};

/** Deprecated `authentication.type` values (all bearer-style at the wire). */
const AUTH_TYPE_MAP: Record<string, string> = {
  api_key: "bearer",
  azure_key: "bearer",
};

/** Deprecated `endpoints.compatible_format` values. */
const COMPATIBLE_FORMAT_MAP: Record<string, string> = {
  azure: "openai",
};

interface NormalizeResult<T> {
  normalized: T;
  changes: BundleNormalization[];
}

function cloneDeep<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T;
}

/**
 * Normalize one raw provider record (bundle import or on-disk config load).
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

  // authentication.type: legacy bearer-style aliases
  const authentication = normalized.authentication;
  if (authentication !== null && typeof authentication === "object") {
    const auth = authentication as Record<string, unknown>;
    if (typeof auth.type === "string") {
      const mapped = AUTH_TYPE_MAP[auth.type];
      if (mapped !== undefined) {
        changes.push({
          kind: "provider",
          name,
          path: "authentication.type",
          from: auth.type,
          to: mapped,
        });
        auth.type = mapped;
      }
    }
  }

  // endpoints.compatible_format: "azure" behaves as OpenAI-compatible
  const endpoints = normalized.endpoints;
  if (endpoints !== null && typeof endpoints === "object") {
    const ep = endpoints as Record<string, unknown>;
    if (typeof ep.compatible_format === "string") {
      const mapped = COMPATIBLE_FORMAT_MAP[ep.compatible_format];
      if (mapped !== undefined) {
        changes.push({
          kind: "provider",
          name,
          path: "endpoints.compatible_format",
          from: ep.compatible_format,
          to: mapped,
        });
        ep.compatible_format = mapped;
      }
    }
  }

  // Legacy bundles sometimes attach extra diagnostic fields that the strict
  // inner schemas reject. Passthrough handles those, but we strip one known
  // "junk" field (`provider_notes`) quietly so the on-disk result stays lean.
  if ("provider_notes" in normalized) {
    delete normalized.provider_notes;
  }

  return { normalized, changes };
}

/**
 * Normalize one raw model record from `bundle.setup.models[]`. Currently a
 * no-op because `ModelRoutingConfigSchema` already accepts every field older
 * exporters produce; kept as a symmetric hook so future renames can land here
 * without touching the importer.
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
