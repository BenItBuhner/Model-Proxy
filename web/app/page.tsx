"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelBody } from "@/components/ui/panel";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import {
  getCurrentUserAnalytics,
  getCurrentUserLimits,
  getAnalytics,
  getHealth,
  getLogs,
  getMe,
  listAvailableModels,
  type AnalyticsSummary,
  type HealthDetailed,
  type PrincipalInfo,
  type RequestLogRecord,
  type UserLimits,
} from "@/lib/endpoints";
import { formatRelativeTime, truncate } from "@/lib/utils";

export default function DashboardPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <DashboardBody />
      </AppShell>
    </AuthGuard>
  );
}

function DashboardBody(): React.ReactElement {
  const [principal, setPrincipal] = useState<PrincipalInfo | undefined>(undefined);
  const [health, setHealth] = useState<HealthDetailed | undefined>(undefined);
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [allowedModels, setAllowedModels] = useState<string[]>([]);
  const [limits, setLimits] = useState<UserLimits | undefined>(undefined);
  const [logStats, setLogStats] = useState<{
    total: number;
    active: number;
    completed: number;
  } | undefined>(undefined);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | undefined>(undefined);
  const [err, setErr] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const me = await getMe();
        const admin = isAdminPrincipal(me.principal);
        const [h, analyticsResult, logs, modelsResult, limitsResult] = admin
          ? await Promise.all([
              getHealth(),
              getAnalytics(),
              getLogs(15),
              Promise.resolve(undefined),
              Promise.resolve(undefined),
            ])
          : await Promise.all([
              getHealth(),
              getCurrentUserAnalytics(),
              Promise.resolve(undefined),
              listAvailableModels(),
              getCurrentUserLimits(),
            ]);
        if (cancelled) return;
        setPrincipal(me.principal);
        setHealth(h);
        setAnalytics(analyticsResult.summary);
        setRecords(logs?.records ?? []);
        setAllowedModels(modelsResult?.data.map((model) => model.id).sort((a, b) => a.localeCompare(b)) ?? []);
        setLimits(limitsResult?.limits);
        setLogStats({
          total: analyticsResult.summary.totalRequests,
          active: analyticsResult.summary.activeRequests,
          completed: analyticsResult.summary.completedRequests,
        });
        setErr(undefined);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const admin = principal === undefined || isAdminPrincipal(principal);

  if (!admin) {
    return (
      <>
        <PageHeader
          eyebrow="client"
          title="Client Console"
          description="Your assigned models, usage analytics, and account limits."
        />

        {err !== undefined ? (
          <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
            <StatusDot tone="danger" />
            <span className="text-alert-500">{err}</span>
          </div>
        ) : null}

        <div className="mb-6 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Status" value={health?.status ?? "..."} tone="phosphor" sublabel={health !== undefined ? `uptime ${formatUptime(health.uptime_seconds)}` : undefined} />
          <MetricCard label="Requests" value={logStats !== undefined ? formatCount(logStats.total) : "..."} sublabel={logStats !== undefined ? `${logStats.active} running` : undefined} />
          <MetricCard label="Tokens" value={analytics !== undefined ? formatCount(analytics.totalTokens) : "..."} sublabel={analytics !== undefined ? `${formatCount(analytics.completionTokens)} output` : undefined} />
          <MetricCard label="Saved cost" value={analytics !== undefined ? formatUsd(analytics.savedCostUsd) : "-"} sublabel="your account usage" />
        </div>

        <div className="grid gap-5 xl:grid-cols-3">
          <Panel title="allowed models" className="xl:col-span-2" accent toolbar={<Link href="/account" className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-phosphor-500">manage keys</Link>}>
            <PanelBody>
              {allowedModels.length === 0 ? (
                <div className="font-mono text-xs text-bone-300">No models are currently assigned to this account.</div>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {allowedModels.map((model) => (
                    <div key={model} className="border border-ink-500 bg-ink-800 px-3 py-2 font-mono text-xs text-bone-900">
                      {model}
                    </div>
                  ))}
                </div>
              )}
            </PanelBody>
          </Panel>

          <Panel title="limits" accent>
            <PanelBody className="space-y-4">
              <KV label="Requests / minute" value={formatLimit(limits?.requestsPerMinute)} />
              <KV label="Requests / day" value={formatLimit(limits?.requestsPerDay)} />
              <KV label="Tokens / day" value={formatLimit(limits?.tokensPerDay)} />
              <KV label="Cost / day" value={formatUsdLimit(limits?.costUsdPerDay)} />
              <KV label="Concurrent" value={formatLimit(limits?.concurrentRequests)} />
            </PanelBody>
          </Panel>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="overview"
        title="Control surface"
        description="Live view of the routing runtime. All data streams from memory - no completion content ever hits disk."
      />

      {err !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{err}</span>
        </div>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4 mb-6">
        <MetricCard label="Status" value={health?.status ?? "…"} tone="phosphor" sublabel={health !== undefined ? `uptime ${formatUptime(health.uptime_seconds)}` : undefined} />
        <MetricCard label="Requests" value={logStats !== undefined ? formatCount(logStats.total) : "…"} sublabel={logStats !== undefined ? `${logStats.active} running · ${formatCount(logStats.completed)} completed` : undefined} />
        <MetricCard label="Saved cost" value={analytics !== undefined ? formatUsd(analytics.savedCostUsd) : "–"} sublabel={analytics !== undefined ? `${formatCount(analytics.totalTokens)} tokens` : "persistent analytics"} />
        <MetricCard label="Avg speed" value={analytics?.avgTokensPerSecond !== undefined ? `${analytics.avgTokensPerSecond.toFixed(1)} tok/s` : "–"} sublabel={analytics?.p95LatencyMs !== undefined ? `p95 ${formatDurationMs(analytics.p95LatencyMs)}` : "completed only"} />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="recent activity" className="xl:col-span-2" accent toolbar={<Link href="/observability" className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-phosphor-500">observability →</Link>}>
          <Table>
            <Thead>
              <Tr>
                <Th width="14ch">When</Th>
                <Th>Model</Th>
                <Th>Route</Th>
                <Th align="right" width="10ch">Duration</Th>
                <Th align="right" width="10ch">Tokens in</Th>
                <Th align="right" width="10ch">Speed</Th>
                <Th align="center" width="14ch">Status</Th>
              </Tr>
            </Thead>
            <tbody>
              {records.length === 0 ? (
                <EmptyRow colSpan={7}>no requests yet</EmptyRow>
              ) : (
                records.map((r) => (
                  <Tr key={r.requestId} className={r.state === "running" ? "bg-phosphor-50/40" : undefined}>
                    <Td className="text-bone-300">{formatRelativeTime(r.timestamp)}</Td>
                    <Td className="text-bone-900">{truncate(r.requestedModel, 30)}</Td>
                    <Td>
                      {r.resolvedProvider !== undefined ? (
                        <span className="text-bone-500">
                          {r.resolvedProvider}
                          <span className="text-bone-300">/</span>
                          {truncate(r.resolvedModel ?? "-", 22)}
                        </span>
                      ) : (
                        <span className="text-bone-300">–</span>
                      )}
                    </Td>
                    <Td align="right" className="text-bone-500">
                      {formatDurationMs(r.elapsedMs)}
                    </Td>
                    <Td align="right" className="text-bone-500">
                      {formatTokenCount(r.promptTokens, r.promptTokensEstimated)}
                    </Td>
                    <Td align="right" className="text-bone-500">
                      {formatSpeed(r)}
                    </Td>
                    <Td align="center">
                      <StatusChip status={r.responseStatus} error={r.errorType} enforce={r.enforceMode} state={r.state} />
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </Panel>

        <Panel title="system" accent>
          <PanelBody className="space-y-4">
            <KV label="Bun" value={health?.runtime.bun ?? "–"} />
            <KV label="Platform" value={`${health?.runtime.platform ?? "-"}/${health?.runtime.arch ?? "-"}`} />
            <KV label="Mode" value={health?.runtime.node_env ?? "development"} />
            <div className="hairline" />
            <KV label="Models" value={`${health?.models_count ?? 0}`} emphasis />
            <KV label="Providers" value={`${health?.providers_count ?? 0}`} emphasis />
            <div className="hairline" />
            <div className="space-y-1.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">Auth</div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <StatusDot tone={health?.auth_configured === true ? "phosphor" : "warning"} />
                <span className="text-bone-700">
                  {health?.auth_configured === true ? "key enforced" : "auth disabled"}
                </span>
              </div>
            </div>
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}

function MetricCard({
  label,
  value,
  sublabel,
  tone,
}: {
  label: string;
  value: string;
  sublabel?: string;
  tone?: "phosphor";
}): React.ReactElement {
  return (
    <div className="corners bg-ink-800 px-5 py-5 shadow-edge">
      <div className="flex items-center justify-between">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
          {label}
        </div>
        {tone === "phosphor" ? <StatusDot /> : null}
      </div>
      <div className="mt-3 font-mono text-[28px] text-bone-900 leading-none">
        {value}
      </div>
      {sublabel !== undefined ? (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-500">
          {sublabel}
        </div>
      ) : null}
    </div>
  );
}

function KV({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
        {label}
      </span>
      <span
        className={
          emphasis
            ? "font-mono text-[18px] text-bone-900"
            : "font-mono text-[11px] text-bone-700"
        }
      >
        {value}
      </span>
    </div>
  );
}

function StatusChip({
  status,
  error,
  enforce,
  state,
}: {
  status?: number;
  error?: string;
  enforce: boolean;
  state: "running" | "completed";
}): React.ReactElement {
  if (state === "running") return <Badge tone="phosphor">running</Badge>;
  if (status === undefined) return <Badge tone="muted">pending</Badge>;
  if (status >= 500) return <Badge tone="danger">{status}</Badge>;
  if (status >= 400) return <Badge tone="warning">{status}</Badge>;
  if (error !== undefined) return <Badge tone="warning">{status}</Badge>;
  return enforce ? <Badge tone="phosphor">{status} · enforce</Badge> : <Badge tone="bone">{status}</Badge>;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatTokenCount(value: number | undefined, estimated: boolean | undefined): string {
  if (value === undefined) return "–";
  return `${value}${estimated === true ? "~" : ""}`;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatUsd(value: number): string {
  return `$${value.toFixed(6)}`;
}

function formatLimit(value: number | undefined): string {
  return value === undefined ? "unlimited" : formatCount(value);
}

function formatUsdLimit(value: number | undefined): string {
  return value === undefined ? "unlimited" : `$${value.toFixed(2)}`;
}

function formatSpeed(record: RequestLogRecord): string {
  if (
    record.completionTokens !== undefined &&
    record.responseTimeMs !== undefined &&
    record.responseTimeMs > 0
  ) {
    return `${(record.completionTokens / (record.responseTimeMs / 1000)).toFixed(1)} tok/s`;
  }
  if (record.streamBytes !== undefined && record.elapsedMs > 0) {
    return `${(record.streamBytes / (record.elapsedMs / 1000) / 1024).toFixed(1)} KB/s`;
  }
  return "–";
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function isAdminPrincipal(principal: PrincipalInfo): boolean {
  return principal.isOwner || principal.role === "owner" || principal.role === "admin";
}
