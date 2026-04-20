"use client";

import { apiFetch, getStoredApiKey } from "./api";

// ---------------------------------------------------------------------------
// Types (mirrored from shared/schemas/config-bundle.ts — duplicated here so the
// Next.js build does not need to cross into the server workspace).
// ---------------------------------------------------------------------------

export interface BundleApiKeyEntry {
  env_var: string;
  value: string;
}

export interface ConfigBundle {
  version: string;
  exported_at?: string;
  metadata?: Record<string, unknown>;
  setup: {
    providers: Array<Record<string, unknown>>;
    models: Array<Record<string, unknown>>;
    environment: Record<string, string>;
    api_keys: Record<string, BundleApiKeyEntry[]>;
  };
}

export type ImportConflictPolicy = "overwrite" | "skip";

export interface ImportSectionsFlags {
  providers?: boolean;
  models?: boolean;
  env?: boolean;
}

export interface ImportOptions {
  conflict_policy?: ImportConflictPolicy;
  sections?: ImportSectionsFlags;
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
  dry_run: true;
}

export interface ImportReport extends Omit<BundleDiff, "dry_run"> {
  applied: { providers: number; models: number; env: number };
  paths: { providers_dir: string; models_dir: string; env: string };
  aborted: boolean;
  dry_run: false;
}

// ---------------------------------------------------------------------------
// Client wrappers
// ---------------------------------------------------------------------------

/**
 * Download the full configuration bundle. Bypasses `apiFetch` because we need
 * the raw Response (including `Content-Disposition` headers) to turn it into
 * a file download.
 */
export async function exportBundle(): Promise<{
  bundle: ConfigBundle;
  filename: string;
}> {
  const key = getStoredApiKey();
  const res = await fetch(`/v1/admin/config/export`, {
    method: "GET",
    credentials: "include",
    headers: key !== undefined ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === "string") message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  const bundle = (await res.json()) as ConfigBundle;
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = extractFilename(res.headers.get("content-disposition")) ??
    `model-proxy-config-${stamp}.json`;
  return { bundle, filename };
}

function extractFilename(headerValue: string | null): string | undefined {
  if (headerValue === null) return undefined;
  const match = /filename\s*=\s*"?([^";]+)"?/i.exec(headerValue);
  return match?.[1];
}

export async function previewBundle(
  bundle: ConfigBundle,
  options?: ImportOptions,
): Promise<BundleDiff> {
  return apiFetch<BundleDiff>(`/v1/admin/config/import?dry_run=true`, {
    method: "POST",
    body: { bundle, options },
  });
}

export async function applyBundle(
  bundle: ConfigBundle,
  options?: ImportOptions,
): Promise<ImportReport> {
  return apiFetch<ImportReport>(`/v1/admin/config/import`, {
    method: "POST",
    body: { bundle, options },
  });
}

/**
 * Trigger a file download using an anchor element. Safe to call from a button
 * click handler.
 */
export function downloadBundle(bundle: ConfigBundle, filename: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
