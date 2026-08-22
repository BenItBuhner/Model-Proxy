"use client";

import { useEffect, useMemo, useState } from "react";
import { AnalyticsFilters } from "@/components/observability/analytics-filters";
import { CostSettingsPanel } from "@/components/observability/cost-settings-panel";
import { formatCount } from "@/components/observability/metric-widget";
import { RequestDetailPanel, type RequestTrace } from "@/components/observability/request-detail-panel";
import { RequestLogTable } from "@/components/observability/request-log-table";
import { UsageDashboard } from "@/components/observability/usage-dashboard";
import {
  OBSERVABILITY_PAGE_SIZE,
  useObservabilityData,
} from "@/components/observability/use-observability-data";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { apiFetch } from "@/lib/api";
import type { ObservabilityFilters } from "@/lib/endpoints";
import { openEventStream, type EventStreamHandle } from "@/lib/test-dispatch";
import type { RequestEvent } from "@model-proxy/contracts/api/events.ts";
import Link from "next/link";

export default function LogsPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <ObservabilityBody />
      </AppShell>
    </AuthGuard>
  );
}

function ObservabilityBody(): React.ReactElement {
  const [filters, setFilters] = useState<ObservabilityFilters>({});
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [trace, setTrace] = useState<RequestTrace | undefined>(undefined);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const { records, total, completed, active, hasMore, error, reload } =
    useObservabilityData(filters, offset);

  useEffect(() => {
    if (records.length > 0 && (selectedId === undefined || !records.some((record) => record.requestId === selectedId))) {
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

        // Request is still running — subscribe to the live event stream so the
        // fusion pipeline view and timeline update in real time. The stream
        // replays the backlog first, so rebuild the event list from scratch.
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
    loadTrace();
    return () => {
      cancelled = true;
      stream?.close();
    };
  }, [selectedId]);

  const selectedRecord = useMemo(
    () => records.find((record) => record.requestId === selectedId),
    [records, selectedId],
  );
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + records.length, total);

  const updateFilters = (next: ObservabilityFilters): void => {
    setFilters(next);
    setOffset(0);
  };

  return (
    <>
      <PageHeader
        eyebrow="observability"
        title="Observability"
        description="Interactive usage trends, persistent request analytics, savings, cache matches, and verbose routing traces."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href="/usage"
              className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-phosphor-500"
            >
              usage →
            </Link>
            <Button variant="outline" onClick={() => void reload()}>
              refresh
            </Button>
          </div>
        }
      />

      {error !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      <div className="space-y-5">
        <UsageDashboard
          audience="admin"
          scope="admin"
          showCostSettingsSlot={<CostSettingsPanel />}
        />

        <AnalyticsFilters filters={filters} onChange={updateFilters} />

        <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(420px,4fr)]">
          <Panel
            title="request history"
            subtitle={`${formatCount(completed)} completed retained · ${formatCount(active)} running`}
            accent
            toolbar={
              <div className="flex items-center gap-2">
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
