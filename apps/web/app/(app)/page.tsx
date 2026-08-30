"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatCompact,
  formatCount,
  formatDurationMs,
  formatPercent,
  formatUsd,
  formatUptime,
} from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { KV, MetricCard } from "@/components/ui/metric-card";
import { Panel, PanelBody } from "@/components/ui/panel";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import { UsageTrendChart } from "@/components/observability/usage-trend-chart";
import {
  getAnalytics,
  getAnalyticsTimeseries,
  getHealth,
  getLogs,
  getMe,
  getSetupStatus,
  type AnalyticsSummary,
  type AnalyticsTimeseriesPoint,
  type HealthDetailed,
  type PrincipalInfo,
  type RequestLogRecord,
} from "@/lib/endpoints";
import { fillTimeseriesGaps } from "@/lib/usage-range";
import { formatRelativeTime, truncate } from "@/lib/utils";

const POLL_MS = 4000;
const SETUP_POLL_MS = 30_000;
const TREND_WINDOW_MS = 24 * 60 * 60 * 1000;

export default function DashboardPage(): React.ReactElement {
  return <DashboardBody />;
}

function DashboardBody(): React.ReactElement {
  const router = useRouter();
  const [principal, setPrincipal] = useState<PrincipalInfo | undefined>(undefined);
  const [identityErr, setIdentityErr] = useState<string | undefined>(undefined);
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const [health, setHealth] = useState<HealthDetailed | undefined>(undefined);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | undefined>(undefined);
  const [previous, setPrevious] = useState<AnalyticsSummary | undefined>(undefined);
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [trendPoints, setTrendPoints] = useState<AnalyticsTimeseriesPoint[] | undefined>(undefined);
  const [setup, setSetup] = useState<
    { needs_setup: boolean; models_count: number; providers_count: number } | undefined
  >(undefined);
  const [err, setErr] = useState<string | undefined>(undefined);
  const admin = isAdminPrincipal(principal);

  // Identify the viewer once; non-admins belong in the account console.
  useEffect(() => {
    let cancelled = false;
    setIdentityErr(undefined);
    getMe()
      .then((me) => {
        if (cancelled) return;
        setPrincipal(me.principal);
        if (!isAdminPrincipal(me.principal)) router.replace("/account");
      })
      .catch((e) => {
        if (!cancelled) setIdentityErr((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [router, identityAttempt]);

  // Poll runtime data only once we know the viewer is an admin.
  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    let inFlight = false;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const now = Date.now();
        const currentSince = new Date(now - TREND_WINDOW_MS).toISOString();
        const previousSince = new Date(now - 2 * TREND_WINDOW_MS).toISOString();
        const [h, analyticsResult, previousResult, logs, timeseries] = await Promise.all([
          getHealth(),
          getAnalytics({ since: currentSince }),
          getAnalytics({ since: previousSince, until: currentSince }),
          getLogs(12),
          getAnalyticsTimeseries({ since: currentSince }, "hour"),
        ]);
        if (cancelled) return;
        setHealth(h);
        setAnalytics(analyticsResult.summary);
        setPrevious(previousResult.summary);
        setRecords(logs.records);
        setTrendPoints(timeseries.points);
        setErr(undefined);
      } catch (e) {
        if (!cancelled) setErr((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [admin]);

  // First-run setup status changes rarely; poll it gently.
  useEffect(() => {
    if (!admin) return;
    let cancelled = false;
    const loadSetup = (): void => {
      getSetupStatus()
        .then((status) => {
          if (!cancelled) setSetup(status);
        })
        .catch(() => {});
    };
    loadSetup();
    const id = setInterval(loadSetup, SETUP_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [admin]);

  if (principal === undefined && identityErr === undefined) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
        loading overview…
      </div>
    );
  }

  if (identityErr !== undefined) {
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4">
        <div className="flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{identityErr}</span>
        </div>
        <Button variant="outline" onClick={() => setIdentityAttempt((n) => n + 1)}>
          retry
        </Button>
      </div>
    );
  }

  if (!admin) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
        redirecting to your account console…
      </div>
    );
  }

  return (
    <>
      <PageHeader
        eyebrow="overview"
        title="Control surface"
        description="Live view of the routing runtime - traffic, tokens, cache efficiency, and spend at a glance."
      />

      {err !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{err}</span>
        </div>
      ) : null}

      {setup?.needs_setup === true ? (
        <Panel title="getting started" accent className="mb-6">
          <PanelBody className="space-y-4">
            <p className="max-w-[72ch] text-sm text-bone-500">
              No models are routed yet. Three steps and the proxy is live -
              everything is configured right here, no config files needed.
            </p>
            <ol className="space-y-2 font-mono text-[12px] text-bone-700">
              <li className="flex items-center gap-3">
                <span className="text-phosphor-500">01</span>
                <Link href="/test-environment?tab=env" className="underline decoration-ink-300 underline-offset-4 hover:text-phosphor-500">
                  Add a provider API key
                </Link>
                <span className="text-bone-300">
                  ({setup.providers_count} providers ready out of the box)
                </span>
              </li>
              <li className="flex items-center gap-3">
                <span className="text-phosphor-500">02</span>
                <Link href="/models" className="underline decoration-ink-300 underline-offset-4 hover:text-phosphor-500">
                  Create a logical model
                </Link>
                <span className="text-bone-300">(pick provider + upstream model, add fallbacks)</span>
              </li>
              <li className="flex items-center gap-3">
                <span className="text-phosphor-500">03</span>
                <Link href="/test-environment?tab=test" className="underline decoration-ink-300 underline-offset-4 hover:text-phosphor-500">
                  Send a test request
                </Link>
                <span className="text-bone-300">(then point any OpenAI/Anthropic client at this proxy)</span>
              </li>
            </ol>
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4 mb-6">
        <MetricCard
          label="Requests · 24h"
          value={analytics !== undefined ? formatCount(analytics.totalRequests) : "…"}
          delta={percentDelta(analytics?.totalRequests, previous?.totalRequests)}
          deltaTitle="vs previous 24 hours"
          sublabel={
            analytics !== undefined
              ? `${analytics.activeRequests} running · ${formatCount(analytics.failedRequests)} failed`
              : undefined
          }
        />
        <MetricCard
          label="Tokens · 24h"
          value={analytics !== undefined ? formatCompact(analytics.totalTokens) : "…"}
          delta={percentDelta(analytics?.totalTokens, previous?.totalTokens)}
          deltaTitle="vs previous 24 hours"
          sublabel={
            analytics !== undefined
              ? `in ${formatCompact(analytics.promptTokens)} · out ${formatCompact(analytics.completionTokens)}`
              : undefined
          }
        />
        <MetricCard
          label="Cache hit rate · 24h"
          value={
            analytics !== undefined && analytics.totalRequests > 0
              ? formatPercent(analytics.cacheHits / analytics.totalRequests)
              : analytics !== undefined
                ? "-"
                : "…"
          }
          sublabel={
            analytics !== undefined
              ? `${formatCount(analytics.cacheHits)} hits · ${formatCompact(analytics.matchedTokens)} tok matched`
              : undefined
          }
        />
        <MetricCard
          label="Spend · 24h"
          value={analytics !== undefined ? formatUsd(analytics.userCostUsd) : "…"}
          delta={percentDelta(analytics?.userCostUsd, previous?.userCostUsd)}
          deltaTitle="vs previous 24 hours"
          sublabel={
            analytics !== undefined
              ? `${formatUsd(analytics.savedCostUsd)} saved of ${formatUsd(analytics.typicalCostUsd)} typical`
              : undefined
          }
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-3 mb-6">
        <Panel
          title="last 24 hours"
          subtitle={trendSubtitle(analytics)}
          accent
          className="xl:col-span-2"
          toolbar={
            <Link href="/usage" className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-phosphor-500">
              full usage →
            </Link>
          }
        >
          <PanelBody>
            {trendPoints === undefined ? (
              <div className="flex h-[280px] items-center justify-center font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">
                loading…
              </div>
            ) : (
              <Trend points={trendPoints} />
            )}
          </PanelBody>
        </Panel>

        <Panel title="system" accent>
          <PanelBody className="space-y-4">
            <KV label="Uptime" value={health !== undefined ? formatUptime(health.uptime_seconds) : "…"} emphasis />
            <div className="hairline" />
            <KV label="Bun" value={health?.runtime.bun ?? "-"} />
            <KV label="Platform" value={`${health?.runtime.platform ?? "-"}/${health?.runtime.arch ?? "-"}`} />
            <KV label="Mode" value={health?.runtime.node_env ?? "development"} />
            <div className="hairline" />
            <KV label="Models" value={health !== undefined ? `${health.models_count}` : "…"} emphasis />
            <KV label="Providers" value={health !== undefined ? `${health.providers_count}` : "…"} emphasis />
            <div className="hairline" />
            <div className="space-y-1.5">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">Auth</div>
              <div className="flex items-center gap-2 font-mono text-[11px]">
                <StatusDot tone={health?.auth_configured === true ? "phosphor" : "warning"} />
                <span className="text-bone-700">
                  {health === undefined ? "…" : health.auth_configured ? "key enforced" : "auth disabled"}
                </span>
              </div>
            </div>
          </PanelBody>
        </Panel>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel
          title="recent activity"
          subtitle="click a request to open its full trace"
          accent
          className="xl:col-span-2"
          toolbar={
            <Link href="/usage" className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-phosphor-500">
              view all →
            </Link>
          }
        >
          <Table>
            <Thead>
              <Tr>
                <Th width="14ch">When</Th>
                <Th>Model</Th>
                <Th>Route</Th>
                <Th align="right" width="12ch">Duration</Th>
                <Th align="right" width="18ch">Tokens (in → out)</Th>
                <Th align="center" width="14ch">Status</Th>
              </Tr>
            </Thead>
            <tbody>
              {records.length === 0 ? (
                <EmptyRow colSpan={6}>{analytics === undefined ? "loading…" : "no requests yet"}</EmptyRow>
              ) : (
                records.map((r) => {
                  const failed = r.errorType !== undefined || (r.responseStatus ?? 0) >= 400;
                  return (
                    <Tr
                      key={r.requestId}
                      onClick={() => router.push(`/usage?request=${encodeURIComponent(r.requestId)}`)}
                      className={r.state === "running" ? "bg-phosphor-50/40" : undefined}
                      title={failed && r.errorMessage !== undefined ? r.errorMessage : undefined}
                    >
                      <Td className="text-bone-300" title={new Date(r.timestamp).toLocaleString()}>
                        {formatRelativeTime(r.timestamp)}
                      </Td>
                      <Td className="text-bone-900">{truncate(r.requestedModel, 30)}</Td>
                      <Td>
                        {r.resolvedProvider !== undefined ? (
                          <span className="text-bone-500">
                            {r.resolvedProvider}
                            <span className="text-bone-300">/</span>
                            {truncate(r.resolvedModel ?? "-", 22)}
                          </span>
                        ) : (
                          <span className="text-bone-300">-</span>
                        )}
                      </Td>
                      <Td align="right" className="text-bone-500">
                        {formatDurationMs(r.elapsedMs)}
                      </Td>
                      <Td align="right" className="text-bone-500">
                        {formatTokensCell(r)}
                      </Td>
                      <Td align="center">
                        <StatusChip status={r.responseStatus} error={r.errorType} enforce={r.enforceMode} state={r.state} />
                      </Td>
                    </Tr>
                  );
                })
              )}
            </tbody>
          </Table>
        </Panel>

        <Panel title="top routes" subtitle="by requests in window" accent>
          <PanelBody className="space-y-2">
            <TopRoutes summary={analytics} />
          </PanelBody>
        </Panel>
      </div>
    </>
  );
}

function TopRoutes({ summary }: { summary: AnalyticsSummary | undefined }): React.ReactElement {
  const routes = useMemo(() => {
    const byRoute = new Map<string, { provider: string; model: string; requests: number; tokens: number; saved: number }>();
    for (const row of summary?.byProviderKey ?? []) {
      const key = `${row.provider}/${row.model}`;
      const current = byRoute.get(key);
      if (current === undefined) {
        byRoute.set(key, {
          provider: row.provider,
          model: row.model,
          requests: row.requests,
          tokens: row.totalTokens,
          saved: row.savedCostUsd,
        });
      } else {
        current.requests += row.requests;
        current.tokens += row.totalTokens;
        current.saved += row.savedCostUsd;
      }
    }
    return Array.from(byRoute.values())
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 6);
  }, [summary]);

  if (routes.length === 0) {
    return (
      <div className="py-10 text-center font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">
        no routed traffic yet
      </div>
    );
  }
  const max = routes[0]!.requests;
  return (
    <>
      {routes.map((route) => (
        <div key={`${route.provider}/${route.model}`} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-[11px] text-bone-900" title={`${route.provider} / ${route.model}`}>
              {route.provider}
              <span className="text-bone-300">/</span>
              {route.model}
            </span>
            <span className="shrink-0 font-mono text-[11px] text-bone-500">{formatCount(route.requests)}</span>
          </div>
          <div className="h-1 w-full bg-ink-600">
            <div
              className="h-full bg-phosphor-500/70"
              style={{ width: `${max > 0 ? Math.max(4, (route.requests / max) * 100) : 4}%` }}
            />
          </div>
        </div>
      ))}
    </>
  );
}

function Trend({ points }: { points: AnalyticsTimeseriesPoint[] }): React.ReactElement {
  const filled = useMemo(() => {
    const since = new Date(Date.now() - TREND_WINDOW_MS).toISOString();
    return fillTimeseriesGaps(points, {
      since,
      bucket: "hour",
      createEmpty: (bucket) => ({
        bucket,
        requests: 0,
        totalTokens: 0,
        userCostUsd: 0,
        typicalCostUsd: 0,
        savedCostUsd: 0,
      }),
    });
  }, [points]);
  if (!filled.some((point) => point.requests > 0)) {
    return (
      <div className="flex h-[280px] items-center justify-center font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">
        no requests in the last 24 hours
      </div>
    );
  }
  return <UsageTrendChart points={filled} bucket="hour" metric="both" />;
}

function trendSubtitle(analytics: AnalyticsSummary | undefined): string {
  if (analytics === undefined) return "hourly buckets";
  const parts: string[] = ["hourly buckets"];
  if (analytics.avgTokensPerSecond !== undefined) {
    parts.push(`avg ${analytics.avgTokensPerSecond.toFixed(1)} tok/s`);
  }
  if (analytics.p95LatencyMs !== undefined) {
    parts.push(`p95 ${formatDurationMs(analytics.p95LatencyMs)}`);
  }
  return parts.join(" · ");
}

/** "in → out" token cell with a "~" prefix marking estimated counts. */
function formatTokensCell(record: RequestLogRecord): string {
  const { promptTokens, completionTokens } = record;
  if (promptTokens === undefined && completionTokens === undefined) return "-";
  const part = (value: number | undefined, estimated: boolean | undefined): string => {
    if (value === undefined) return "-";
    return `${estimated === true ? "~" : ""}${formatCompact(value)}`;
  };
  return `${part(promptTokens, record.promptTokensEstimated)} → ${part(completionTokens, record.completionTokensEstimated)}`;
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

function isAdminPrincipal(principal: PrincipalInfo | undefined): boolean {
  if (principal === undefined) return false;
  return principal.isOwner === true || principal.role === "owner" || principal.role === "admin";
}

/** Percent change between two windows; undefined when there is no baseline. */
function percentDelta(current: number | undefined, previous: number | undefined): number | undefined {
  if (current === undefined || previous === undefined || previous <= 0) return undefined;
  return ((current - previous) / previous) * 100;
}
