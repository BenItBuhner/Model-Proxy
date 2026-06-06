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
  getHealth,
  getLogs,
  type HealthDetailed,
  type RequestLogRecord,
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
  const [health, setHealth] = useState<HealthDetailed | undefined>(undefined);
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [totalInBuffer, setTotalInBuffer] = useState(0);
  const [err, setErr] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [h, logs] = await Promise.all([getHealth(), getLogs(15)]);
        if (cancelled) return;
        setHealth(h);
        setRecords(logs.records);
        setTotalInBuffer(logs.total_in_buffer);
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

  const metrics = computeMetrics(records);

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
        <MetricCard
          label="Responses"
          value={String(health?.request_stats?.requests_finished ?? totalInBuffer)}
          sublabel={
            health?.request_stats !== undefined
              ? `${health.request_stats.responses_ok} ok · ${health.request_stats.responses_error} err since start`
              : `${metrics.success} ok · ${metrics.failed} err in buffer`
          }
        />
        <MetricCard label="Avg latency" value={metrics.avgMs !== undefined ? `${metrics.avgMs}ms` : "–"} sublabel={metrics.p95Ms !== undefined ? `p95 ${metrics.p95Ms}ms` : undefined} />
        <MetricCard label="Enforce mode" value={`${metrics.enforcedPercent}%`} sublabel="last 15 requests" />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel title="recent activity" className="xl:col-span-2" accent toolbar={<Link href="/logs" className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-phosphor-500">full log →</Link>}>
          <Table>
            <Thead>
              <Tr>
                <Th width="14ch">When</Th>
                <Th>Model</Th>
                <Th>Route</Th>
                <Th align="right" width="10ch">Latency</Th>
                <Th align="center" width="14ch">Status</Th>
              </Tr>
            </Thead>
            <tbody>
              {records.length === 0 ? (
                <EmptyRow colSpan={5}>no requests yet</EmptyRow>
              ) : (
                records.map((r) => (
                  <Tr key={r.requestId}>
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
                      {r.responseTimeMs !== undefined ? `${r.responseTimeMs}` : "-"}
                    </Td>
                    <Td align="center">
                      <StatusChip status={r.responseStatus} error={r.errorType} enforce={r.enforceMode} />
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

function computeMetrics(records: RequestLogRecord[]): {
  success: number;
  failed: number;
  avgMs: number | undefined;
  p95Ms: number | undefined;
  enforcedPercent: number;
} {
  if (records.length === 0) {
    return { success: 0, failed: 0, avgMs: undefined, p95Ms: undefined, enforcedPercent: 0 };
  }
  let success = 0;
  let failed = 0;
  let enforced = 0;
  const latencies: number[] = [];
  for (const r of records) {
    if (r.responseStatus !== undefined && r.responseStatus < 400) success += 1;
    else failed += 1;
    if (r.responseTimeMs !== undefined) latencies.push(r.responseTimeMs);
    if (r.enforceMode) enforced += 1;
  }
  const avgMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : undefined;
  const sorted = [...latencies].sort((a, b) => a - b);
  const p95Ms =
    sorted.length > 0 ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : undefined;
  const enforcedPercent = Math.round((enforced / records.length) * 100);
  return { success, failed, avgMs, p95Ms, enforcedPercent };
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
}: {
  status?: number;
  error?: string;
  enforce: boolean;
}): React.ReactElement {
  if (status === undefined) return <Badge tone="muted">pending</Badge>;
  if (status >= 500) return <Badge tone="danger">{status}</Badge>;
  if (status >= 400) return <Badge tone="warning">{status}</Badge>;
  if (error !== undefined) return <Badge tone="warning">{status}</Badge>;
  return enforce ? <Badge tone="phosphor">{status} · enforce</Badge> : <Badge tone="bone">{status}</Badge>;
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
