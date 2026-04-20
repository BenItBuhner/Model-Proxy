"use client";

import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { BundlePanel } from "@/components/config/bundle-panel";

/**
 * Dedicated top-level page for full-configuration bundle migration. Lives
 * behind the same `AuthGuard` every other admin page uses, so unauthenticated
 * users are bounced to `/login` before any import/export UI even renders.
 *
 * The server endpoints themselves (`GET /v1/admin/config/export`,
 * `POST /v1/admin/config/import`) are independently gated via the existing
 * `protectedApp.use("/v1/admin/config/*", gate)` middleware in
 * `src/server/routes/admin.ts`, so even a direct `fetch` from an unauthed
 * client gets a 401.
 */
export default function ConfigPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <ConfigBody />
      </AppShell>
    </AuthGuard>
  );
}

function ConfigBody(): React.ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="config"
        title="Bundle import & export"
        description="Download the full running configuration as a single JSON file, or import a bundle (from another Model-Proxy instance or the Python-era exporter) with a live dry-run diff before anything touches disk. Requires admin authentication."
        actions={<Badge tone="warning">contains secrets</Badge>}
      />

      <BundlePanel />
    </>
  );
}
