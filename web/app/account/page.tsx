"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Panel, PanelBody } from "@/components/ui/panel";
import {
  createUserApiKey,
  getCurrentUserAnalytics,
  getCurrentUserLimits,
  getMe,
  listAvailableModels,
  type AnalyticsSummary,
  type PrincipalInfo,
  type UserLimits,
} from "@/lib/endpoints";

export default function AccountPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <AccountBody />
      </AppShell>
    </AuthGuard>
  );
}

function AccountBody(): React.ReactElement {
  const [principal, setPrincipal] = useState<PrincipalInfo | undefined>();
  const [analytics, setAnalytics] = useState<AnalyticsSummary | undefined>();
  const [limits, setLimits] = useState<UserLimits | undefined>();
  const [models, setModels] = useState<string[]>([]);
  const [label, setLabel] = useState("Default key");
  const [key, setKey] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    Promise.all([
      getMe(),
      getCurrentUserAnalytics(),
      getCurrentUserLimits(),
      listAvailableModels(),
    ])
      .then(([me, analyticsResult, limitsResult, modelsResult]) => {
        setPrincipal(me.principal);
        setAnalytics(analyticsResult.summary);
        setLimits(limitsResult.limits);
        setModels(modelsResult.data.map((model) => model.id).sort((a, b) => a.localeCompare(b)));
      })
      .catch((err) => setError((err as Error).message));
  }, []);

  const generate = async (): Promise<void> => {
    setError(undefined);
    try {
      const result = await createUserApiKey(label);
      setKey(result.api_key.key);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="client" title="Account Console" description="Your API keys, allowed models, limits, and usage." />
      {error !== undefined ? <div className="text-alert-500">{error}</div> : null}

      <div className="grid gap-5 lg:grid-cols-3">
        <Panel title="profile">
          <PanelBody className="space-y-3 font-mono text-xs text-bone-500">
            <KV label="Email" value={principal?.email ?? "legacy owner session"} />
            <KV label="Role" value={principal?.role ?? "unknown"} />
            <KV label="Completion logging" value={principal?.completionLoggingEnabled ? "enabled" : "disabled"} />
          </PanelBody>
        </Panel>
        <MetricCard label="Requests" value={analytics !== undefined ? formatCount(analytics.totalRequests) : "..."} sublabel={`${analytics?.activeRequests ?? 0} running`} />
        <MetricCard label="Tokens" value={analytics !== undefined ? formatCount(analytics.totalTokens) : "..."} sublabel={`${formatCount(analytics?.completionTokens ?? 0)} output`} />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="allowed models" className="xl:col-span-2">
          <PanelBody>
            {models.length === 0 ? (
              <div className="font-mono text-xs text-bone-300">No models are currently assigned to this account.</div>
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                {models.map((model) => (
                  <div key={model} className="border border-ink-500 bg-ink-800 px-3 py-2 font-mono text-xs text-bone-900">
                    {model}
                  </div>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
        <Panel title="limits">
          <PanelBody className="space-y-3">
            <KV label="Requests / minute" value={formatLimit(limits?.requestsPerMinute)} />
            <KV label="Requests / day" value={formatLimit(limits?.requestsPerDay)} />
            <KV label="Tokens / day" value={formatLimit(limits?.tokensPerDay)} />
            <KV label="Cost / day" value={formatUsdLimit(limits?.costUsdPerDay)} />
            <KV label="Concurrent" value={formatLimit(limits?.concurrentRequests)} />
          </PanelBody>
        </Panel>
      </div>

      <Panel title="generate api key">
        <PanelBody className="space-y-4">
          <div>
            <Label htmlFor="key-label">Key label</Label>
            <Input id="key-label" value={label} onChange={(event) => setLabel(event.target.value)} />
          </div>
          <Button onClick={() => void generate()}>generate key</Button>
          {key !== undefined ? (
            <pre className="overflow-auto bg-ink-900 p-3 text-xs text-bone-900">{key}</pre>
          ) : null}
        </PanelBody>
      </Panel>
    </div>
  );
}

function MetricCard({ label, value, sublabel }: { label: string; value: string; sublabel: string }): React.ReactElement {
  return (
    <div className="corners bg-ink-800 px-5 py-5 shadow-edge">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">{label}</div>
      <div className="mt-3 font-mono text-[28px] leading-none text-bone-900">{value}</div>
      <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-500">{sublabel}</div>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">{label}</span>
      <span className="text-right font-mono text-[11px] text-bone-700">{value}</span>
    </div>
  );
}

function formatLimit(value: number | undefined): string {
  return value === undefined ? "unlimited" : formatCount(value);
}

function formatUsdLimit(value: number | undefined): string {
  return value === undefined ? "unlimited" : `$${value.toFixed(2)}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}
