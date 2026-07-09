"use client";

import { useEffect, useMemo, useState } from "react";
import { RequestDetailPanel, type RequestTrace } from "@/components/observability/request-detail-panel";
import { RequestLogTable } from "@/components/observability/request-log-table";
import {
  OBSERVABILITY_PAGE_SIZE,
  useObservabilityData,
} from "@/components/observability/use-observability-data";
import { formatCount, formatDurationMs, formatUsd } from "@/components/observability/metric-widget";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody } from "@/components/ui/panel";
import { apiFetch } from "@/lib/api";
import type { ObservabilityFilters, RequestLogRecord } from "@/lib/endpoints";
import { openEventStream, type EventStreamHandle } from "@/lib/test-dispatch";
import type { RequestEvent } from "@/lib/test-events";

const FUSION_MODEL = "fusion-beta";

export default function FusionPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <FusionBody />
      </AppShell>
    </AuthGuard>
  );
}

function FusionBody(): React.ReactElement {
  const filters: ObservabilityFilters = useMemo(() => ({ model: FUSION_MODEL }), []);
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [trace, setTrace] = useState<RequestTrace | undefined>(undefined);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const { records, summary, total, completed, active, hasMore, error, reload } =
    useObservabilityData(filters, offset);

  useEffect(() => {
    if (records.length === 0) {
      setSelectedId(undefined);
      return;
    }
    if (selectedId === undefined || !records.some((record) => record.requestId === selectedId)) {
      setSelectedId(records[0]?.requestId);
    }
  }, [records, selectedId]);

  useEffect(() => {
    if (selectedId === undefined) {
      setTrace(undefined);
      return;
    }

    const requestId = selectedId;
    let cancelled = false;
    let stream: EventStreamHandle | undefined;

    async function loadTrace(): Promise<void> {
      setLoadingTrace(true);
      try {
        const next = await apiFetch<RequestTrace>(`/v1/admin/events/${encodeURIComponent(requestId)}`);
        if (cancelled) return;
        setTrace(next);
        if (next.finished) return;

        const liveEvents: RequestEvent[] = [];
        stream = openEventStream(requestId, {
          onEvent: (event) => {
            if (cancelled) return;
            liveEvents.push(event);
            setTrace({
              ...next,
              finished: event.type === "request.finished",
              events: [...liveEvents],
            });
          },
          onDone: () => {
            if (cancelled) return;
            setTrace((current) => (current === undefined ? current : { ...current, finished: true }));
          },
        });
      } catch {
        if (!cancelled) setTrace(undefined);
      } finally {
        if (!cancelled) setLoadingTrace(false);
      }
    }

    void loadTrace();
    return () => {
      cancelled = true;
      stream?.close();
    };
  }, [selectedId]);

  const selectedRecord = useMemo(
    () => records.find((record) => record.requestId === selectedId),
    [records, selectedId],
  );

  const fusionStats = useMemo(() => summarizeFusionRecords(records), [records]);
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + records.length, total);

  return (
    <>
      <PageHeader
        eyebrow="fusion"
        title="Fusion"
        description="Live and retained traces for fusion-beta orchestration, subagent context packing, cache reuse, and synthesis."
        actions={
          <Button variant="outline" onClick={() => void reload()}>
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

      <div className="space-y-5">
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <FusionMetric label="active" value={formatCount(active)} tone={active > 0 ? "phosphor" : "muted"} />
          <FusionMetric label="completed" value={formatCount(completed)} />
          <FusionMetric label="avg latency" value={formatDurationMs(summary?.avgLatencyMs)} />
          <FusionMetric label="saved" value={formatUsd(summary?.savedCostUsd)} />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Panel title="recent fusion runs" accent>
            <PanelBody className="grid grid-cols-3 gap-3">
              <MiniStat label="success" value={formatCount(fusionStats.successful)} />
              <MiniStat label="errors" value={formatCount(fusionStats.failed)} />
              <MiniStat label="cache hits" value={formatCount(fusionStats.cacheHits)} />
            </PanelBody>
          </Panel>
          <Panel title="streaming mix" accent>
            <PanelBody className="grid grid-cols-2 gap-3">
              <MiniStat label="streaming" value={formatCount(fusionStats.streaming)} />
              <MiniStat label="batch" value={formatCount(Math.max(0, records.length - fusionStats.streaming))} />
            </PanelBody>
          </Panel>
          <Panel title="token profile" accent>
            <PanelBody className="grid grid-cols-2 gap-3">
              <MiniStat label="tokens" value={formatCount(summary?.totalTokens)} />
              <MiniStat label="matched" value={formatCount(summary?.matchedTokens)} />
            </PanelBody>
          </Panel>
        </div>

        <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(420px,4fr)]">
          <Panel
            title="fusion request history"
            subtitle={`${formatCount(total)} retained for ${FUSION_MODEL}`}
            accent
            toolbar={
              <div className="flex items-center gap-2">
                <Badge tone="phosphor">{FUSION_MODEL}</Badge>
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
                  {formatCount(pageStart)}-{formatCount(pageEnd)}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - OBSERVABILITY_PAGE_SIZE))}
                >
                  newer
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={!hasMore}
                  onClick={() => setOffset(offset + OBSERVABILITY_PAGE_SIZE)}
                >
                  older
                </Button>
              </div>
            }
          >
            <RequestLogTable records={records} selectedId={selectedId} onSelect={setSelectedId} />
          </Panel>

          <RequestDetailPanel record={selectedRecord} trace={trace} loadingTrace={loadingTrace} />
        </div>
      </div>
    </>
  );
}

function summarizeFusionRecords(records: RequestLogRecord[]): {
  successful: number;
  failed: number;
  streaming: number;
  cacheHits: number;
} {
  return records.reduce(
    (acc, record) => {
      if (record.responseStatus !== undefined && record.responseStatus < 400) acc.successful++;
      if (record.errorType !== undefined || (record.responseStatus ?? 0) >= 400) acc.failed++;
      if (record.isStreaming) acc.streaming++;
      if (record.isCacheHit) acc.cacheHits++;
      return acc;
    },
    { successful: 0, failed: 0, streaming: 0, cacheHits: 0 },
  );
}

function FusionMetric({
  label,
  value,
  tone = "bone",
}: {
  label: string;
  value: string;
  tone?: "phosphor" | "bone" | "muted";
}): React.ReactElement {
  const toneClass = tone === "phosphor"
    ? "text-phosphor-500"
    : tone === "muted"
      ? "text-bone-300"
      : "text-bone-900";
  return (
    <Panel accent>
      <PanelBody className="space-y-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">{label}</div>
        <div className={`font-mono text-2xl leading-none ${toneClass}`}>{value}</div>
      </PanelBody>
    </Panel>
  );
}

function MiniStat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0 border border-ink-500 bg-ink-900 px-3 py-2">
      <div className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-bone-300">{label}</div>
      <div className="mt-1 truncate font-mono text-sm text-bone-800">{value}</div>
    </div>
  );
}
