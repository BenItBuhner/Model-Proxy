"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  formatCount,
  formatLimit,
  formatPercent,
  formatUsd,
  formatUsdLimit,
} from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { KV, MetricCard } from "@/components/ui/metric-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Panel, PanelBody } from "@/components/ui/panel";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import { ProviderAccountsSection } from "@/components/account/provider-accounts";
import {
  createUserApiKey,
  deleteUserApiKey,
  getCurrentUserAnalytics,
  getCurrentUserLimits,
  getMe,
  listAvailableModels,
  listUserApiKeys,
  type AnalyticsSummary,
  type PrincipalInfo,
  type UserApiKeySummary,
  type UserLimits,
} from "@/lib/endpoints";

export default function AccountPage(): React.ReactElement {
  return <AccountBody />;
}

function AccountBody(): React.ReactElement {
  const [principal, setPrincipal] = useState<PrincipalInfo | undefined>();
  const [analytics, setAnalytics] = useState<AnalyticsSummary | undefined>();
  const [limits, setLimits] = useState<UserLimits | undefined>();
  const [models, setModels] = useState<string[]>([]);
  const [keys, setKeys] = useState<UserApiKeySummary[] | undefined>(undefined);
  const [keysError, setKeysError] = useState<string | undefined>(undefined);
  const [label, setLabel] = useState("Default key");
  const [freshKey, setFreshKey] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busyKeyId, setBusyKeyId] = useState<string | undefined>();

  const reloadKeys = useCallback((): void => {
    listUserApiKeys()
      .then((result) => {
        setKeys(result.keys);
        setKeysError(undefined);
      })
      .catch((err) => {
        setKeys(undefined);
        setKeysError((err as Error).message);
      });
  }, []);

  const load = useCallback((): void => {
    void Promise.allSettled([
      getMe(),
      getCurrentUserAnalytics(),
      getCurrentUserLimits(),
      listAvailableModels(),
    ]).then(([me, analyticsResult, limitsResult, modelsResult]) => {
      if (me.status === "fulfilled") {
        setPrincipal(me.value.principal);
        setError(undefined);
      }
      if (analyticsResult.status === "fulfilled") setAnalytics(analyticsResult.value.summary);
      if (limitsResult.status === "fulfilled") setLimits(limitsResult.value.limits);
      if (modelsResult.status === "fulfilled") {
        setModels(modelsResult.value.data.map((model) => model.id).sort((a, b) => a.localeCompare(b)));
      }
      if (me.status === "rejected") {
        setError((me.reason as Error).message);
      }
    });
    reloadKeys();
  }, [reloadKeys]);

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  const generate = async (): Promise<void> => {
    setError(undefined);
    try {
      const result = await createUserApiKey(label);
      setFreshKey(result.api_key.key);
      reloadKeys();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const removeKey = async (key: UserApiKeySummary): Promise<void> => {
    if (!window.confirm(`Delete API key "${key.label ?? key.keyPrefix}"? It will stop working immediately.`)) return;
    setError(undefined);
    setBusyKeyId(key.id);
    try {
      await deleteUserApiKey(key.id);
      reloadKeys();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyKeyId(undefined);
    }
  };

  const cacheRate =
    analytics !== undefined && analytics.completedRequests > 0
      ? analytics.cacheHits / analytics.completedRequests
      : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="account"
        title="Account"
        description="Your usage, API keys, limits, and provider subscription accounts."
      />
      {error !== undefined ? (
        <div className="flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Requests"
          value={analytics !== undefined ? formatCount(analytics.totalRequests) : "…"}
          sublabel={analytics !== undefined ? `${analytics.activeRequests} running · ${formatCount(analytics.failedRequests)} failed` : undefined}
        />
        <MetricCard
          label="Tokens"
          value={analytics !== undefined ? formatCount(analytics.totalTokens) : "…"}
          sublabel={analytics !== undefined ? `in ${formatCount(analytics.promptTokens)} · out ${formatCount(analytics.completionTokens)}` : undefined}
        />
        <MetricCard
          label="Cache hit rate"
          value={analytics !== undefined ? formatPercent(cacheRate) : "…"}
          sublabel={analytics !== undefined ? `${formatCount(analytics.cacheHits)} hits · ${formatCount(analytics.matchedTokens)} matched` : undefined}
        />
        <MetricCard
          label="Saved"
          value={analytics !== undefined ? formatUsd(analytics.savedCostUsd) : "…"}
          sublabel={analytics !== undefined ? `${formatUsd(analytics.userCostUsd)} spend · ${formatUsd(analytics.typicalCostUsd)} typical` : undefined}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <Panel
          title="api keys"
          subtitle="keys authenticate against /v1 - shown once at creation"
          accent
          className="xl:col-span-2"
        >
          <PanelBody className="space-y-4">
            <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
              <div>
                <Label htmlFor="key-label">Key label</Label>
                <Input id="key-label" value={label} onChange={(event) => setLabel(event.target.value)} />
              </div>
              <Button onClick={() => void generate()}>generate key</Button>
            </div>
            {freshKey !== undefined ? (
              <div className="space-y-1">
                <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-phosphor-500">
                  copy now - this key is not shown again
                </div>
                <pre className="overflow-auto bg-ink-900 p-3 text-xs text-bone-900">{freshKey}</pre>
              </div>
            ) : null}
            <div className="border-t border-ink-500 pt-3">
              {keysError !== undefined ? (
                <div className="font-mono text-[11px] text-alert-500">failed to load keys: {keysError}</div>
              ) : keys === undefined ? (
                <div className="font-mono text-[11px] text-bone-300">loading keys…</div>
              ) : keys.length === 0 ? (
                <div className="font-mono text-[11px] text-bone-300">no keys yet - generate one above</div>
              ) : (
                <Table>
                  <Thead>
                    <Tr>
                      <Th>Label</Th>
                      <Th>Key</Th>
                      <Th align="center" width="12ch">Status</Th>
                      <Th align="right" width="14ch">Last used</Th>
                      <Th align="right" width="10ch">Actions</Th>
                    </Tr>
                  </Thead>
                  <tbody>
                    {keys.map((key) => (
                      <Tr key={key.id}>
                        <Td className="text-bone-900">{key.label ?? "-"}</Td>
                        <Td className="text-bone-500">
                          {key.keyPrefix}…{key.keyLastFour}
                        </Td>
                        <Td align="center">
                          <Badge tone={key.status === "active" ? "phosphor" : "muted"}>{key.status}</Badge>
                        </Td>
                        <Td align="right" className="text-bone-300">
                          {key.lastUsedAt !== undefined ? new Date(key.lastUsedAt).toLocaleString() : "never"}
                        </Td>
                        <Td align="right">
                          <Button
                            size="sm"
                            variant="danger"
                            disabled={busyKeyId !== undefined}
                            onClick={() => void removeKey(key)}
                          >
                            delete
                          </Button>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </div>
          </PanelBody>
        </Panel>

        <Panel title="profile" accent>
          <PanelBody className="space-y-3">
            <KV label="Email" value={principal?.email ?? "legacy owner session"} />
            <KV label="Role" value={principal?.role ?? "unknown"} />
            <KV label="Completion logging" value={principal?.completionLoggingEnabled ? "enabled" : "disabled"} />
            <div className="hairline" />
            <div className="font-mono text-[10px] uppercase tracking-[0.16em]">
              <Link href="/usage" className="text-phosphor-500 hover:text-phosphor-400">
                open usage dashboard →
              </Link>
            </div>
          </PanelBody>
        </Panel>
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

      <div className="space-y-4 border-t border-ink-500 pt-6">
        <div>
          <h2 className="font-mono text-[12px] uppercase tracking-[0.2em] text-bone-900">
            Provider accounts
          </h2>
          <p className="mt-1 max-w-[72ch] text-sm text-bone-500">
            Attach personal or shared subscription accounts (ChatGPT/Codex, SuperGrok) and
            provider tokens. Tokens refresh automatically and rotate through the normal
            fallback router.
          </p>
        </div>
        <ProviderAccountsSection />
      </div>
    </div>
  );
}
