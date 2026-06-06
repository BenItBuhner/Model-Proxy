"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyRow, Table, Td, Th, Thead, Tr } from "@/components/ui/table";
import { getLogs, type RequestLogRecord } from "@/lib/endpoints";
import { formatRelativeTime, truncate } from "@/lib/utils";

export default function LogsPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <LogsBody />
      </AppShell>
    </AuthGuard>
  );
}

function LogsBody(): React.ReactElement {
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [activeCount, setActiveCount] = useState(0);
  const [totalInBuffer, setTotalInBuffer] = useState(0);
  const [err, setErr] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const logs = await getLogs(150);
        if (cancelled) return;
        setRecords(logs.records);
        setActiveCount(logs.active_count);
        setTotalInBuffer(logs.total_in_buffer);
        setErr(undefined);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      }
    };
    load();
    const id = setInterval(load, 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const metrics = useMemo(() => computeLogMetrics(records), [records]);

  return (
    <>
      <PageHeader
        eyebrow="observability"
        title="Request logs"
        description="Live in-memory request tracking. Running completions appear here before they finish; no prompt or completion content is persisted."
      />

      {err !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{err}</span>
        </div>
      ) : null}

      <div className="mb-6 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Running" value={String(activeCount)} sublabel="currently active" tone={activeCount > 0 ? "phosphor" : undefined} />
        <MetricCard label="Completed buffer" value={String(totalInBuffer)} sublabel="recent finished requests" />
        <MetricCard label="Avg duration" value={metrics.avgDurationMs !== undefined ? formatDurationMs(metrics.avgDurationMs) : "–"} sublabel={metrics.p95DurationMs !== undefined ? `p95 ${formatDurationMs(metrics.p95DurationMs)}` : "completed only"} />
        <MetricCard label="Avg output speed" value={metrics.avgTokensPerSecond !== undefined ? `${metrics.avgTokensPerSecond.toFixed(1)} tok/s` : "–"} sublabel="completed token usage" />
      </div>

      {metrics.running.length > 0 ? (
        <Panel title="running now" accent className="mb-6" badge={<Badge tone="phosphor">{metrics.running.length}</Badge>}>
          <LogTable records={metrics.running} emptyText="no active requests" />
        </Panel>
      ) : null}

      <Panel title="all recent requests" accent subtitle={`${records.length} shown`}>
        <LogTable records={records} emptyText="no requests yet" />
      </Panel>
    </>
  );
}

function LogTable({
  records,
  emptyText,
}: {
  records: RequestLogRecord[];
  emptyText: string;
}): React.ReactElement {
  return (
    <Table>
      <Thead>
        <Tr>
          <Th width="14ch">Started</Th>
          <Th>Model</Th>
          <Th>Route</Th>
          <Th width="11ch">Mode</Th>
          <Th align="right" width="12ch">Duration</Th>
          <Th align="right" width="12ch">Tokens in</Th>
          <Th align="right" width="12ch">Tokens out</Th>
          <Th align="right" width="12ch">Speed</Th>
          <Th align="center" width="14ch">Status</Th>
        </Tr>
      </Thead>
      <tbody>
        {records.length === 0 ? (
          <EmptyRow colSpan={9}>{emptyText}</EmptyRow>
        ) : (
          records.map((record) => (
            <Tr
              key={record.requestId}
              className={record.state === "running" ? "bg-phosphor-50/40" : undefined}
            >
              <Td className="text-bone-300">
                <div>{formatRelativeTime(record.timestamp)}</div>
                <div className="mt-1 text-[10px] text-bone-300">{truncate(record.requestId, 18)}</div>
              </Td>
              <Td className="text-bone-900">{truncate(record.requestedModel, 32)}</Td>
              <Td>
                {record.resolvedProvider !== undefined ? (
                  <span className="text-bone-500">
                    {record.resolvedProvider}
                    <span className="text-bone-300">/</span>
                    {truncate(record.resolvedModel ?? "-", 24)}
                  </span>
                ) : (
                  <span className="text-bone-300">awaiting route</span>
                )}
              </Td>
              <Td className="text-bone-500">
                {record.wireProtocol ?? "-"}
                {record.isStreaming ? " · stream" : ""}
              </Td>
              <Td align="right" className="text-bone-500">
                {formatDurationMs(record.elapsedMs)}
              </Td>
              <Td align="right" className="text-bone-500">
                {formatTokenCount(record.promptTokens, record.promptTokensEstimated)}
              </Td>
              <Td align="right" className="text-bone-500">
                {formatTokenCount(record.completionTokens, false)}
              </Td>
              <Td align="right" className="text-bone-500">
                {formatSpeed(record)}
              </Td>
              <Td align="center">
                <StatusChip record={record} />
              </Td>
            </Tr>
          ))
        )}
      </tbody>
    </Table>
  );
}

function computeLogMetrics(records: RequestLogRecord[]): {
  running: RequestLogRecord[];
  avgDurationMs: number | undefined;
  p95DurationMs: number | undefined;
  avgTokensPerSecond: number | undefined;
} {
  const running = records.filter((record) => record.state === "running");
  const durations = records
    .map((record) => record.responseTimeMs)
    .filter((value): value is number => value !== undefined);
  const speeds = records
    .map((record) => {
      if (
        record.completionTokens === undefined ||
        record.responseTimeMs === undefined ||
        record.responseTimeMs <= 0
      ) {
        return undefined;
      }
      return record.completionTokens / (record.responseTimeMs / 1000);
    })
    .filter((value): value is number => value !== undefined);

  const avgDurationMs =
    durations.length > 0
      ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length)
      : undefined;
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const p95DurationMs =
    sortedDurations.length > 0
      ? sortedDurations[Math.min(sortedDurations.length - 1, Math.floor(sortedDurations.length * 0.95))]
      : undefined;
  const avgTokensPerSecond =
    speeds.length > 0 ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : undefined;

  return { running, avgDurationMs, p95DurationMs, avgTokensPerSecond };
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
      <div className="mt-3 font-mono text-[28px] leading-none text-bone-900">{value}</div>
      {sublabel !== undefined ? (
        <div className="mt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-bone-500">
          {sublabel}
        </div>
      ) : null}
    </div>
  );
}

function StatusChip({ record }: { record: RequestLogRecord }): React.ReactElement {
  if (record.state === "running") return <Badge tone="phosphor">running</Badge>;
  if (record.responseStatus === undefined) return <Badge tone="muted">pending</Badge>;
  if (record.responseStatus >= 500) return <Badge tone="danger">{record.responseStatus}</Badge>;
  if (record.responseStatus >= 400) return <Badge tone="warning">{record.responseStatus}</Badge>;
  if (record.errorType !== undefined) return <Badge tone="warning">{record.responseStatus}</Badge>;
  return record.enforceMode ? (
    <Badge tone="phosphor">{record.responseStatus} · enforce</Badge>
  ) : (
    <Badge tone="bone">{record.responseStatus}</Badge>
  );
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
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { EventTimeline } from "@/components/test/event-timeline";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody } from "@/components/ui/panel";
import { EmptyRow, Table, Td, Th, Thead, Tr } from "@/components/ui/table";
import { apiFetch } from "@/lib/api";
import { getLogs, type RequestLogRecord } from "@/lib/endpoints";
import type { RequestEvent } from "@/lib/test-events";
import { cn, formatRelativeTime, truncate } from "@/lib/utils";

interface RequestTrace {
  requestId: string;
  finished: boolean;
  startedAt: string;
  events: RequestEvent[];
}

export default function LogsPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <LogsBody />
      </AppShell>
    </AuthGuard>
  );
}

function LogsBody(): React.ReactElement {
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [trace, setTrace] = useState<RequestTrace | undefined>(undefined);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const logs = await getLogs(250);
      setRecords(logs.records);
      setTotal(logs.total_in_buffer);
      setError(undefined);
      if (selectedId === undefined && logs.records[0] !== undefined) {
        setSelectedId(logs.records[0].requestId);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [selectedId]);

  useEffect(() => {
    reload();
    const id = setInterval(reload, 4000);
    return () => clearInterval(id);
  }, [reload]);

  useEffect(() => {
    if (selectedId === undefined) {
      setTrace(undefined);
      return;
    }

    const requestId = selectedId;
    let cancelled = false;
    async function loadTrace(): Promise<void> {
      setLoadingTrace(true);
      try {
        const next = await getEventTrace(requestId);
        if (cancelled) return;
        setTrace(next);
        setError(undefined);
      } catch (err) {
        if (cancelled) return;
        setTrace(undefined);
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoadingTrace(false);
      }
    }

    loadTrace();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const selectedRecord = useMemo(
    () => records.find((record) => record.requestId === selectedId),
    [records, selectedId],
  );
  const metrics = useMemo(() => computeMetrics(records), [records]);

  return (
    <>
      <PageHeader
        eyebrow="observability"
        title="Request logs"
        description="Recent in-memory requests with verbose routing traces, fallback decisions, key rotation, proxy rotation, and enforcement events."
        actions={
          <Button variant="outline" onClick={reload}>
            refresh
          </Button>
        }
      />

      {error !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      <div className="mb-5 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Shown" value={String(records.length)} sublabel={`${total} buffered`} />
        <MetricCard label="Failures" value={String(metrics.failed)} sublabel={`${metrics.success} ok`} />
        <MetricCard label="Fallbacks" value={String(metrics.fallbacks)} sublabel="from selected window" />
        <MetricCard label="Avg latency" value={metrics.avgMs !== undefined ? `${metrics.avgMs}ms` : "-"} />
      </div>

      <div className="grid min-h-[720px] gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(420px,4fr)]">
        <Panel
          title="recent requests"
          subtitle="newest first"
          badge={<Badge tone="muted">{records.length}</Badge>}
          accent
        >
          <Table>
            <Thead>
              <Tr>
                <Th width="13ch">When</Th>
                <Th>Request</Th>
                <Th>Route</Th>
                <Th align="right" width="10ch">Latency</Th>
                <Th align="center" width="13ch">Status</Th>
              </Tr>
            </Thead>
            <tbody>
              {records.length === 0 ? (
                <EmptyRow colSpan={5}>no requests recorded</EmptyRow>
              ) : (
                records.map((record) => (
                  <Tr
                    key={record.requestId}
                    onClick={() => setSelectedId(record.requestId)}
                    className={cn(
                      selectedId === record.requestId && "bg-ink-700/80",
                    )}
                  >
                    <Td className="text-bone-300">{formatRelativeTime(record.timestamp)}</Td>
                    <Td>
                      <div className="text-bone-900">{truncate(record.requestedModel, 34)}</div>
                      <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-bone-300">
                        {record.method} {endpointLabel(record.endpoint)}
                      </div>
                    </Td>
                    <Td>
                      {record.resolvedProvider !== undefined ? (
                        <div>
                          <div className="text-bone-700">
                            {record.resolvedProvider}
                            <span className="text-bone-300">/</span>
                            {truncate(record.resolvedModel ?? "-", 28)}
                          </div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-bone-300">
                            {record.wireProtocol ?? "unknown"}
                            {record.isStreaming ? " stream" : ""}
                            {record.enforceMode ? " enforce" : ""}
                          </div>
                        </div>
                      ) : (
                        <span className="text-bone-300">unresolved</span>
                      )}
                    </Td>
                    <Td align="right" className="text-bone-500">
                      {record.responseTimeMs !== undefined ? `${record.responseTimeMs}ms` : "-"}
                    </Td>
                    <Td align="center">
                      <StatusChip record={record} />
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </Panel>

        <div className="flex min-h-0 flex-col gap-5">
          <Panel
            title="selected request"
            subtitle={selectedId !== undefined ? truncate(selectedId, 18) : "none"}
            accent
            toolbar={loadingTrace ? <Badge tone="muted">loading</Badge> : undefined}
          >
            <PanelBody className="space-y-3">
              {selectedRecord === undefined ? (
                <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">
                  select a request to inspect routing decisions
                </div>
              ) : (
                <>
                  <KV label="Request ID" value={selectedRecord.requestId} />
                  <KV label="Started" value={formatTimestamp(selectedRecord.timestamp)} />
                  <KV label="Endpoint" value={`${selectedRecord.method} ${selectedRecord.endpoint}`} />
                  <KV label="Model" value={selectedRecord.requestedModel} />
                  <KV
                    label="Resolved"
                    value={
                      selectedRecord.resolvedProvider !== undefined
                        ? `${selectedRecord.resolvedProvider}/${selectedRecord.resolvedModel ?? "-"}`
                        : "-"
                    }
                  />
                  <KV label="Tokens" value={formatTokens(selectedRecord)} />
                  {selectedRecord.errorMessage !== undefined ? (
                    <div className="rounded-sm bg-[rgba(255,59,48,0.08)] p-3 font-mono text-[11px] leading-5 text-alert-500 shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
                      {selectedRecord.errorType ?? "Error"}: {selectedRecord.errorMessage}
                    </div>
                  ) : null}
                </>
              )}
            </PanelBody>
          </Panel>

          <Panel title="verbose event trace" accent className="min-h-0 flex-1" bodyClassName="h-[520px]">
            <EventTimeline
              events={trace?.events ?? []}
              live={trace?.finished === false}
              onClear={() => setTrace(undefined)}
            />
          </Panel>
        </div>
      </div>
    </>
  );
}

async function getEventTrace(requestId: string): Promise<RequestTrace> {
  return apiFetch(`/v1/admin/events/${encodeURIComponent(requestId)}`);
}

function computeMetrics(records: RequestLogRecord[]): {
  success: number;
  failed: number;
  fallbacks: number;
  avgMs: number | undefined;
} {
  let success = 0;
  let failed = 0;
  let fallbacks = 0;
  const latencies: number[] = [];
  for (const record of records) {
    if (record.responseStatus !== undefined && record.responseStatus < 400) success += 1;
    if (record.responseStatus === undefined || record.responseStatus >= 400) failed += 1;
    if (record.retryCount > 0) fallbacks += 1;
    if (record.responseTimeMs !== undefined) latencies.push(record.responseTimeMs);
  }
  const avgMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : undefined;
  return { success, failed, fallbacks, avgMs };
}

function endpointLabel(endpoint: string): string {
  return endpoint.replace(/^\/v1\//, "");
}

function formatTimestamp(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
}

function formatTokens(record: RequestLogRecord): string {
  if (record.totalTokens !== undefined) return `${record.totalTokens} total`;
  const prompt = record.promptTokens ?? 0;
  const completion = record.completionTokens ?? 0;
  if (prompt > 0 || completion > 0) return `${prompt} prompt / ${completion} completion`;
  return "-";
}

function MetricCard({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: string;
  sublabel?: string;
}): React.ReactElement {
  return (
    <div className="corners bg-ink-800 px-5 py-5 shadow-edge">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
        {label}
      </div>
      <div className="mt-3 font-mono text-[28px] leading-none text-bone-900">
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

function KV({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
        {label}
      </span>
      <span className="min-w-0 break-all text-right font-mono text-[11px] text-bone-700">
        {value}
      </span>
    </div>
  );
}

function StatusChip({ record }: { record: RequestLogRecord }): React.ReactElement {
  const status = record.responseStatus;
  if (status === undefined) return <Badge tone="muted">pending</Badge>;
  if (status >= 500) return <Badge tone="danger">{status}</Badge>;
  if (status >= 400) return <Badge tone="warning">{status}</Badge>;
  if (record.errorType !== undefined) return <Badge tone="warning">{status}</Badge>;
  if (record.retryCount > 0) return <Badge tone="warning">{status} retry</Badge>;
  return record.enforceMode ? <Badge tone="phosphor">{status} enforce</Badge> : <Badge tone="bone">{status}</Badge>;
}
