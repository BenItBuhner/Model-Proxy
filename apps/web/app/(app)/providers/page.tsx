"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelBody } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import {
  deleteProvider,
  getProvider,
  listProviders,
  saveProvider,
  type ProviderListItem,
} from "@/lib/endpoints";
import { formatRelativeTime } from "@/lib/utils";

export default function ProvidersPage(): React.ReactElement {
  return (
        <ProvidersBody />
  );
}

/**
 * Scaffold for a brand-new OpenAI-compatible provider. Providers are pure
 * data: no code changes needed, ever.
 */
function newProviderScaffold(name: string, baseUrl: string): Record<string, unknown> {
  const token = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    name,
    display_name: name,
    enabled: true,
    api_keys: {
      env_var_patterns: [`${token}_API_KEY`, `${token}_API_KEY_{INDEX}`],
    },
    endpoints: {
      base_url: baseUrl,
      completions: "/chat/completions",
      streaming: "/chat/completions",
      compatible_format: "openai",
    },
    authentication: {
      type: "bearer",
      header_name: "Authorization",
      header_format: "Bearer {api_key}",
    },
    error_handling: {
      "401": { action: "global_key_failure" },
      "403": { action: "global_key_failure" },
      "429": { action: "provider_cooldown" },
      "500": { action: "model_key_failure" },
      "502": { action: "model_key_failure" },
      "503": { action: "model_key_failure" },
      "504": { action: "model_key_failure" },
    },
    model_mapping: {},
  };
}

function ProvidersBody(): React.ReactElement {
  const [items, setItems] = useState<ProviderListItem[]>([]);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [raw, setRaw] = useState<string>("");
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newBaseUrl, setNewBaseUrl] = useState("");

  const reload = useCallback(async () => {
    try {
      const result = await listProviders();
      setItems(result.providers);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 5000);
    return () => clearInterval(id);
  }, [reload]);

  async function open(name: string): Promise<void> {
    try {
      const result = await getProvider(name);
      setActive(name);
      setRaw(JSON.stringify(result.provider, null, 2));
      setStatus(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function persist(): Promise<void> {
    if (active === undefined) return;
    setStatus("saving…");
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      await saveProvider(active, parsed);
      setStatus("saved");
      await reload();
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  }

  async function remove(): Promise<void> {
    if (active === undefined) return;
    if (!window.confirm(`Delete provider '${active}'? This will remove the JSON file on disk.`)) return;
    try {
      await deleteProvider(active);
      setActive(undefined);
      setRaw("");
      await reload();
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  }

  async function create(): Promise<void> {
    const name = newName.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
      setError("Provider name must be lowercase letters, digits, dashes, or underscores.");
      return;
    }
    if (newBaseUrl.trim().length === 0) {
      setError("Base URL is required (e.g. https://api.example.com/v1).");
      return;
    }
    try {
      const scaffold = newProviderScaffold(name, newBaseUrl.trim());
      await saveProvider(name, scaffold);
      setCreating(false);
      setNewName("");
      setNewBaseUrl("");
      setError(undefined);
      await reload();
      await open(name);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="providers"
        title="Upstream providers"
        description="Backend configurations for every provider the router can dispatch to. Edit endpoints, auth headers, error handling, and API key patterns."
        actions={
          <div className="flex items-center gap-2">
            <Button onClick={() => setCreating(!creating)}>
              {creating ? "cancel" : "new provider"}
            </Button>
            <Button variant="outline" onClick={reload}>refresh</Button>
          </div>
        }
      />

      {error !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      {creating ? (
        <Panel title="new provider" accent className="mb-6">
          <PanelBody className="space-y-4">
            <p className="max-w-[70ch] text-sm text-bone-500">
              Any OpenAI-compatible upstream works with zero code — this
              scaffolds the JSON, then fine-tune it in the editor. Add the
              matching API key under Test environment → env.
            </p>
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="new-provider-name" hint="lowercase id, e.g. fireworks">
                  Name
                </Label>
                <Input
                  id="new-provider-name"
                  monospace
                  placeholder="fireworks"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="new-provider-url" hint="OpenAI-compatible base URL">
                  Base URL
                </Label>
                <Input
                  id="new-provider-url"
                  monospace
                  placeholder="https://api.fireworks.ai/inference/v1"
                  value={newBaseUrl}
                  onChange={(event) => setNewBaseUrl(event.target.value)}
                />
              </div>
            </div>
            <Button onClick={create} disabled={newName.trim().length === 0 || newBaseUrl.trim().length === 0}>
              create provider
            </Button>
          </PanelBody>
        </Panel>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Panel title={`providers (${items.length})`} accent>
          <Table>
            <Thead>
              <Tr>
                <Th>Name</Th>
                <Th align="center" width="10ch">Status</Th>
                <Th align="right" width="18ch">Modified</Th>
              </Tr>
            </Thead>
            <tbody>
              {items.length === 0 ? (
                <EmptyRow colSpan={3}>no providers configured</EmptyRow>
              ) : (
                items.map((p) => (
                  <Tr
                    key={p.name}
                    onClick={() => open(p.name)}
                    className={
                      p.name === active
                        ? "bg-phosphor-50/50 shadow-[inset_2px_0_0_0_#CDFF00]"
                        : undefined
                    }
                  >
                    <Td className="text-bone-900">{p.name}</Td>
                    <Td align="center">
                      {p.enabled ? (
                        <Badge tone="phosphor">enabled</Badge>
                      ) : (
                        <Badge tone="muted">off</Badge>
                      )}
                    </Td>
                    <Td align="right" className="text-bone-300">
                      {formatRelativeTime(p.modified_at)}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </Panel>

        <Panel
          title={active !== undefined ? `editing · ${active}` : "editor"}
          accent
          toolbar={
            active !== undefined ? (
              <>
                {status !== undefined ? (
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
                    {status}
                  </span>
                ) : null}
                <Button variant="outline" onClick={persist}>save</Button>
                <Button variant="danger" onClick={remove}>delete</Button>
              </>
            ) : null
          }
        >
          {active === undefined ? (
            <div className="flex h-[420px] items-center justify-center p-8 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
              select a provider to edit
            </div>
          ) : (
            <div className="space-y-5 p-5">
              <div>
                <Label htmlFor="provider-json" hint="direct JSON · validated on save">
                  Provider JSON
                </Label>
                <Textarea
                  id="provider-json"
                  value={raw}
                  onChange={(event) => setRaw(event.target.value)}
                  rows={28}
                />
              </div>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
