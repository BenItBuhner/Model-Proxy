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
  const [activeCount, setActiveCount] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [trace, setTrace] = useState<RequestTrace | undefined>(undefined);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const logs = await getLogs(250);
      setRecords(logs.records);
      setTotal(logs.total_in_buffer);
      setActiveCount(logs.active_count);
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
        description="Recent in-memory requests with active duration, token estimates, response speed, and verbose routing traces."
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
        <MetricCard label="Shown" value={String(records.length)} sublabel={`${total} completed buffered`} />
        <MetricCard label="Running" value={String(activeCount)} sublabel={`${metrics.fallbacks} retries/fallbacks`} />
        <MetricCard label="Failures" value={String(metrics.failed)} sublabel={`${metrics.success} ok · completed`} />
        <MetricCard label="Avg speed" value={metrics.avgTokensPerSecond !== undefined ? `${metrics.avgTokensPerSecond.toFixed(1)} tok/s` : "-"} sublabel={metrics.avgMs !== undefined ? `avg ${formatDurationMs(metrics.avgMs)}` : "completed only"} />
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
                <Th align="right" width="10ch">Duration</Th>
                <Th align="right" width="10ch">Tokens</Th>
                <Th align="right" width="10ch">Speed</Th>
                <Th align="center" width="13ch">Status</Th>
              </Tr>
            </Thead>
            <tbody>
              {records.length === 0 ? (
                <EmptyRow colSpan={7}>no requests recorded</EmptyRow>
              ) : (
                records.map((record) => (
                  <Tr
                    key={record.requestId}
                    onClick={() => setSelectedId(record.requestId)}
                    className={cn(
                      record.state === "running" && "bg-phosphor-50/40",
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
                        <span className="text-bone-300">awaiting route</span>
                      )}
                    </Td>
                    <Td align="right" className="text-bone-500">
                      {formatDurationMs(record.elapsedMs)}
                    </Td>
                    <Td align="right" className="text-bone-500">
                      {formatTokenCount(record.promptTokens, record.promptTokensEstimated)}
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
                  <KV label="State" value={selectedRecord.state} />
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
                  <KV label="Duration" value={formatDurationMs(selectedRecord.elapsedMs)} />
                  <KV label="Speed" value={formatSpeed(selectedRecord)} />
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
  avgTokensPerSecond: number | undefined;
} {
  let success = 0;
  let failed = 0;
  let fallbacks = 0;
  const latencies: number[] = [];
  const tokenSpeeds: number[] = [];
  for (const record of records) {
    if (record.state === "running") {
      // Running requests are alive, not failed.
    } else if (record.responseStatus !== undefined && record.responseStatus < 400) {
      success += 1;
    } else {
      failed += 1;
    }
    if (record.retryCount > 0) fallbacks += 1;
    if (record.responseTimeMs !== undefined) latencies.push(record.responseTimeMs);
    if (
      record.completionTokens !== undefined &&
      record.responseTimeMs !== undefined &&
      record.responseTimeMs > 0
    ) {
      tokenSpeeds.push(record.completionTokens / (record.responseTimeMs / 1000));
    }
  }
  const avgMs =
    latencies.length > 0
      ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
      : undefined;
  const avgTokensPerSecond =
    tokenSpeeds.length > 0
      ? tokenSpeeds.reduce((sum, value) => sum + value, 0) / tokenSpeeds.length
      : undefined;
  return { success, failed, fallbacks, avgMs, avgTokensPerSecond };
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
  const prompt = formatTokenCount(record.promptTokens, record.promptTokensEstimated);
  const completion = formatTokenCount(record.completionTokens, false);
  if (prompt !== "–" || completion !== "–") return `${prompt} prompt / ${completion} completion`;
  return "-";
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
  if (record.state === "running") return <Badge tone="phosphor">running</Badge>;
  if (status === undefined) return <Badge tone="muted">pending</Badge>;
  if (status >= 500) return <Badge tone="danger">{status}</Badge>;
  if (status >= 400) return <Badge tone="warning">{status}</Badge>;
  if (record.errorType !== undefined) return <Badge tone="warning">{status}</Badge>;
  if (record.retryCount > 0) return <Badge tone="warning">{status} retry</Badge>;
  return record.enforceMode ? <Badge tone="phosphor">{status} enforce</Badge> : <Badge tone="bone">{status}</Badge>;
}
