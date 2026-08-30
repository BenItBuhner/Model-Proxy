"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AnalyticsFilters } from "@/components/observability/analytics-filters";
import { CostSettingsPanel } from "@/components/observability/cost-settings-panel";
import { formatCount } from "@/lib/format";
import { RequestDetailPanel, type RequestTrace } from "@/components/observability/request-detail-panel";
import { RequestLogTable } from "@/components/observability/request-log-table";
import { AnalyticsDashboard } from "@/components/observability/analytics-dashboard";
import { UsageBreakdownTable } from "@/components/observability/usage-breakdown";
import { UsageTimeRangeControls } from "@/components/observability/usage-time-range";
import { UsageTrendChart } from "@/components/observability/usage-trend-chart";
import { UsageDashboard } from "@/components/observability/usage-dashboard";
import { useUsagePageData, USAGE_PAGE_SIZE } from "@/components/observability/use-usage-page-data";
import { useUsageRange } from "@/components/observability/use-usage-range";
import { PageHeader } from "@/components/page-header";
import { StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody } from "@/components/ui/panel";
import { apiFetch } from "@/lib/api";
import { getMe, type ObservabilityFilters, type PrincipalInfo, type RequestLogRecord } from "@/lib/endpoints";
import { openEventStream, type EventStreamHandle } from "@/lib/test-dispatch";
import type { RequestEvent } from "@model-proxy/contracts/api/events.ts";

export default function UsagePage(): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">loading…</div>
      }
    >
      <UsageBody />
    </Suspense>
  );
}

function isAdminPrincipal(principal: PrincipalInfo | undefined): boolean {
  if (principal === undefined) return false;
  return principal.isOwner === true || principal.role === "owner" || principal.role === "admin";
}

function UsageBody(): React.ReactElement {
  const [principal, setPrincipal] = useState<PrincipalInfo | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const searchParams = useSearchParams();
  const initialModel = searchParams.get("model") ?? undefined;
  const requestParam = searchParams.get("request") ?? undefined;
  const [filters, setFilters] = useState<ObservabilityFilters>(() => ({
    ...(initialModel !== undefined ? { model: initialModel } : {}),
    ...(requestParam !== undefined ? { search: requestParam } : {}),
  }));
  const admin = isAdminPrincipal(principal);

  useEffect(() => {
    getMe()
      .then((me) => setPrincipal(me.principal))
      .catch((err) => setError((err as Error).message));
  }, []);

  // Do not pick an audience until identity resolves; rendering the user
  // dashboard for an admin (or vice versa) fires wrong-audience requests and
  // flashes the wrong view.
  if (principal === undefined && error === undefined) {
    return (
      <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">loading…</div>
    );
  }

  if (!admin) {
    return (
      <>
        <PageHeader
          eyebrow="client"
          title="Usage"
          description="Track tokens, dollar spend, and historical trends. Hover the chart for any point in time, pick a window, or set your own counter start."
        />
        {error !== undefined ? <div className="mb-5 text-alert-500">{error}</div> : null}
        {error === undefined ? <UsageDashboard audience="user" scope={principal?.userId ?? "user"} /> : null}
      </>
    );
  }

  return <AdminUsageView barFilters={filters} onBarFiltersChange={setFilters} />;
}

function AdminUsageView({
  barFilters,
  onBarFiltersChange,
}: {
  barFilters: ObservabilityFilters;
  onBarFiltersChange: (filters: ObservabilityFilters) => void;
}): React.ReactElement {
  const range = useUsageRange("admin");
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [trace, setTrace] = useState<RequestTrace | undefined>(undefined);
  const [loadingTrace, setLoadingTrace] = useState(false);
  const lastSelectedRecordRef = useRef<RequestLogRecord | undefined>(undefined);

  // One filter model: the time-range window merged with the filter bar drives
  // the summary tiles, trend chart, route breakdown, and request log alike.
  const filters = useMemo<ObservabilityFilters>(
    () => ({ ...barFilters, since: range.since, until: range.until }),
    [barFilters, range.since, range.until],
  );
  const { records, summary, points, total, completed, active, hasMore, error, reload } =
    useUsagePageData({ filters, bucket: range.bucket, offset });

  useEffect(() => {
    const selected = records.find((record) => record.requestId === selectedId);
    if (selected !== undefined) {
      lastSelectedRecordRef.current = selected;
      return;
    }
    if (selectedId === undefined && records.length > 0) {
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

        // Request is still running - subscribe to the live event stream so the
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

  const selectedRecord = useMemo(() => {
    const current = records.find((record) => record.requestId === selectedId);
    return current ?? lastSelectedRecordRef.current;
  }, [records, selectedId]);
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + records.length, total);

  const updateFilters = (next: ObservabilityFilters): void => {
    onBarFiltersChange(next);
    setOffset(0);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="admin"
        title="Usage"
        description="Usage trends, route breakdown, request analytics, and verbose routing traces. The time frame and filters apply to every panel below."
        actions={
          <Button variant="outline" onClick={() => void reload()}>
            refresh
          </Button>
        }
      />

      <UsageTimeRangeControls
        preset={range.preset}
        onPresetChange={range.setPreset}
        customSince={range.customSince}
        customUntil={range.customUntil}
        onCustomRangeChange={range.setCustomRange}
        counterStart={range.counterStart}
        onCounterStartChange={range.setCounterStart}
        bucket={range.bucket}
        onBucketChange={range.setBucket}
      />

      <AnalyticsFilters filters={barFilters} onChange={updateFilters} />

      {error !== undefined ? (
        <div className="flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      <AnalyticsDashboard summary={summary} />

      <Panel
        title="usage trends"
        subtitle={`hover any point · ${range.bucket} buckets`}
        accent
      >
        <PanelBody>
          <UsageTrendChart points={points} bucket={range.bucket} metric="both" />
        </PanelBody>
      </Panel>

      <Panel title="route breakdown" subtitle="tokens and dollars by provider / model / key" accent>
        <UsageBreakdownTable summary={summary} />
      </Panel>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(420px,4fr)]">
        <Panel
          title="request history"
          subtitle={`${formatCount(completed)} completed · ${formatCount(active)} running in window`}
          accent
          toolbar={
            <div className="flex items-center gap-3">
              <span
                className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-phosphor-500"
                title="auto-refreshes every 4 seconds"
              >
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-phosphor-500 opacity-60" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-phosphor-500" />
                </span>
                live
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
                {formatCount(pageStart)}-{formatCount(pageEnd)}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - USAGE_PAGE_SIZE))}
              >
                newer
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!hasMore}
                onClick={() => setOffset(offset + USAGE_PAGE_SIZE)}
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

      <details>
        <summary className="cursor-pointer select-none font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-phosphor-500">
          cost settings
        </summary>
        <div className="mt-4">
          <CostSettingsPanel />
        </div>
      </details>
    </div>
  );
}
