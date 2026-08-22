"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { UsageDashboard } from "@/components/observability/usage-dashboard";
import { CostSettingsPanel } from "@/components/observability/cost-settings-panel";
import { PageHeader } from "@/components/page-header";
import { getMe, type PrincipalInfo } from "@/lib/endpoints";

export default function UsagePage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <UsageBody />
      </AppShell>
    </AuthGuard>
  );
}

function UsageBody(): React.ReactElement {
  const [principal, setPrincipal] = useState<PrincipalInfo | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    getMe()
      .then((me) => setPrincipal(me.principal))
      .catch((err) => setError((err as Error).message));
  }, []);

  const admin =
    principal !== undefined &&
    (principal.isOwner === true || principal.role === "owner" || principal.role === "admin");

  if (principal === undefined && error === undefined) {
    return (
      <>
        <PageHeader
          eyebrow="usage"
          title="Usage"
          description="Track tokens, dollar spend, and historical trends."
        />
        <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">
          loading usage…
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow={admin ? "admin" : "client"}
        title="Usage"
        description="Track tokens, dollar spend, and historical trends. Hover the chart for any point in time, pick a window, or set your own counter start."
      />
      {error !== undefined ? <div className="mb-5 text-alert-500">{error}</div> : null}
      <UsageDashboard
        audience={admin ? "admin" : "user"}
        scope={principal?.userId ?? (admin ? "admin" : "user")}
        showCostSettingsSlot={admin ? <CostSettingsPanel /> : undefined}
      />
    </>
  );
}
