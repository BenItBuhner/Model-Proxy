"use client";

import type {
  BundleDiff as BundleDiffBase,
  ConfigBundle,
  ImportOptions,
  ImportReport as ImportReportBase,
} from "@model-proxy/contracts/schemas/config-bundle.ts";

import { apiFetch } from "./api";

export type {
  BundleApiKeyEntry,
  BundleEnvDiff,
  BundleNormalization,
  BundleSectionDiff,
  ConfigBundle,
  ImportConflictPolicy,
  ImportOptions,
  ImportSectionsFlags,
} from "@model-proxy/contracts/schemas/config-bundle.ts";

export type BundleDiff = BundleDiffBase & { dry_run: true };
export type ImportReport = ImportReportBase & { dry_run: false };

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
  const res = await fetch(`/v1/admin/config/export`, {
    method: "GET",
    credentials: "include",
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
