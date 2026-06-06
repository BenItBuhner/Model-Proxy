"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelBody } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import { discoverProxies, getProxyStatus, type ProxyDiscoveryReport, type ProxyProviderStatus } from "@/lib/endpoints";

export default function ProxiesPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <ProxiesBody />
      </AppShell>
    </AuthGuard>
  );
}

function ProxiesBody(): React.ReactElement {
  const [providers, setProviders] = useState<ProxyProviderStatus[]>([]);
  const [shared, setShared] = useState<string[]>([]);
  const [report, setReport] = useState<ProxyDiscoveryReport | undefined>(undefined);
  const [target, setTarget] = useState("50");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      const result = await getProxyStatus();
      setProviders(result.status.providers);
      setShared(result.status.shared);
      setReport(result.last_discovery);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function runDiscovery(): Promise<void> {
    setRunning(true);
    setError(undefined);
    try {
      const result = await discoverProxies({
        target_count: Number.parseInt(target, 10) || 50,
        providers: ["opencode", "nvidia"],
        persist: true,
      });
      setReport(result.report);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="egress"
        title="Proxy discovery"
        description="Verify public HTTP proxies across configured providers and persist the shared pool."
        actions={<Button variant="outline" onClick={reload}>refresh</Button>}
      />

      {error !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
        <Panel title="discovery" accent>
          <PanelBody className="space-y-4">
            <div>
              <Label htmlFor="target-count" hint="persisted as MODEL_PROXY_EGRESS_PROXY_N">Target count</Label>
              <Input id="target-count" value={target} onChange={(event) => setTarget(event.target.value)} monospace />
            </div>
            <Button onClick={runDiscovery} disabled={running}>
              {running ? "discovering…" : "discover proxies"}
            </Button>
            <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-500">
              shared pool · {shared.length}
            </div>
          </PanelBody>
        </Panel>

        <Panel title="provider coverage" accent>
          <Table>
            <Thead>
              <Tr><Th>Provider</Th><Th align="center">Enabled</Th><Th align="right">Proxies</Th></Tr>
            </Thead>
            <tbody>
              {providers.length === 0 ? <EmptyRow colSpan={3}>no proxy-enabled providers</EmptyRow> : providers.map((provider) => (
                <Tr key={provider.provider}>
                  <Td>{provider.provider}</Td>
                  <Td align="center">{provider.enabled ? <Badge tone="phosphor">yes</Badge> : <Badge tone="muted">no</Badge>}</Td>
                  <Td align="right">{provider.proxyCount}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      </div>

      <Panel title="last discovery" accent className="mt-5">
        <PanelBody>
          {report === undefined ? (
            <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">no discovery run yet</div>
          ) : (
            <pre className="max-h-[420px] overflow-auto bg-ink-900 p-4 text-[11px] leading-5 text-bone-700">
              {JSON.stringify(report, null, 2)}
            </pre>
          )}
        </PanelBody>
      </Panel>
    </>
  );
}
