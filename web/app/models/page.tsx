"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Textarea, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import {
  createModel,
  deleteModel,
  getModel,
  listModels,
  saveModel,
  type ModelListItem,
} from "@/lib/endpoints";
import { formatRelativeTime } from "@/lib/utils";

export default function ModelsPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <ModelsBody />
      </AppShell>
    </AuthGuard>
  );
}

interface EnforceConfig {
  enabled?: boolean;
  termination_flag?: string;
  max_retries?: number;
  guidance?: string;
  empty_response_policy?: "strict" | "lenient";
  stream_chunk_delay_ms?: number;
}

interface ModelDraft {
  logical_name: string;
  timeout_seconds: number;
  default_cooldown_seconds: number;
  enforce_tool_call: EnforceConfig | undefined;
  model_routings: Array<Record<string, unknown>>;
  fallback_model_routings: string[];
  raw: string;
}

function emptyModel(name: string): ModelDraft {
  return {
    logical_name: name,
    timeout_seconds: 60,
    default_cooldown_seconds: 180,
    enforce_tool_call: undefined,
    model_routings: [{ provider: "groq", model: "", wire_protocol: "openai" }],
    fallback_model_routings: [],
    raw: "",
  };
}

function ModelsBody(): React.ReactElement {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<ModelDraft | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [creatingNew, setCreatingNew] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listModels();
      setModels(result.models);
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function openModel(name: string): Promise<void> {
    try {
      const result = await getModel(name);
      const payload = result.model as Record<string, unknown>;
      const draft: ModelDraft = {
        logical_name: String(payload["logical_name"] ?? name),
        timeout_seconds: Number(payload["timeout_seconds"] ?? 60),
        default_cooldown_seconds: Number(payload["default_cooldown_seconds"] ?? 180),
        enforce_tool_call: (payload["enforce_tool_call"] as EnforceConfig | undefined) ?? undefined,
        model_routings: (payload["model_routings"] as Array<Record<string, unknown>>) ?? [],
        fallback_model_routings:
          (payload["fallback_model_routings"] as string[] | undefined) ?? [],
        raw: JSON.stringify(payload, null, 2),
      };
      setActive(name);
      setDraft(draft);
      setCreatingNew(false);
      setStatus(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  function beginCreate(): void {
    setCreatingNew(true);
    setActive(undefined);
    const draft = emptyModel("new-model");
    draft.raw = JSON.stringify(
      {
        logical_name: draft.logical_name,
        timeout_seconds: 60,
        default_cooldown_seconds: 180,
        model_routings: draft.model_routings,
        fallback_model_routings: [],
      },
      null,
      2,
    );
    setDraft(draft);
    setStatus(undefined);
  }

  async function persist(): Promise<void> {
    if (draft === undefined) return;
    setStatus("saving…");
    try {
      const parsed = JSON.parse(draft.raw) as Record<string, unknown>;
      if (creatingNew) {
        await createModel(String(parsed["logical_name"]), parsed);
      } else if (active !== undefined) {
        await saveModel(active, parsed);
      }
      setStatus("saved");
      await reload();
      setCreatingNew(false);
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  }

  async function remove(): Promise<void> {
    if (active === undefined) return;
    if (!window.confirm(`Delete model '${active}'? This is not reversible.`)) return;
    await deleteModel(active);
    setActive(undefined);
    setDraft(undefined);
    await reload();
  }

  function updateRaw(raw: string): void {
    if (draft === undefined) return;
    setDraft({ ...draft, raw });
  }

  function toggleEnforce(enabled: boolean): void {
    if (draft === undefined) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft.raw) as Record<string, unknown>;
    } catch {
      return;
    }
    if (enabled) {
      const existing = (parsed["enforce_tool_call"] as EnforceConfig | undefined) ?? {};
      parsed["enforce_tool_call"] = {
        enabled: true,
        termination_flag:
          existing.termination_flag ?? '{"tool_loop":"completed"}',
        max_retries: existing.max_retries ?? 10,
        empty_response_policy: existing.empty_response_policy ?? "strict",
        ...(existing.guidance !== undefined ? { guidance: existing.guidance } : {}),
      };
    } else {
      const existing = (parsed["enforce_tool_call"] as EnforceConfig | undefined) ?? {};
      parsed["enforce_tool_call"] = { ...existing, enabled: false };
    }
    setDraft({ ...draft, raw: JSON.stringify(parsed, null, 2) });
  }

  const activeDraft = draft;
  const enforceConfig = activeDraft !== undefined ? parseEnforce(activeDraft.raw) : undefined;

  return (
    <>
      <PageHeader
        eyebrow="models"
        title="Routing configuration"
        description="Each logical model is one JSON file under config/models. Define ordered provider routes, fallbacks, and per-model tool-call enforcement."
        actions={
          <>
            <Button variant="outline" onClick={reload}>
              refresh
            </Button>
            <Button onClick={beginCreate}>+ new model</Button>
          </>
        }
      />

      {error !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <Panel title={`models (${models.length})`} accent>
          <Table>
            <Thead>
              <Tr>
                <Th>Logical name</Th>
                <Th align="right" width="18ch">Modified</Th>
              </Tr>
            </Thead>
            <tbody>
              {loading ? (
                <EmptyRow colSpan={2}>…loading</EmptyRow>
              ) : models.length === 0 ? (
                <EmptyRow colSpan={2}>no models configured</EmptyRow>
              ) : (
                models.map((m) => (
                  <Tr
                    key={m.logical_name}
                    onClick={() => openModel(m.logical_name)}
                    className={
                      m.logical_name === active
                        ? "bg-phosphor-50/50 shadow-[inset_2px_0_0_0_var(--phosphor-500)]"
                        : undefined
                    }
                  >
                    <Td className="text-bone-900">{m.logical_name}</Td>
                    <Td align="right" className="text-bone-300">
                      {formatRelativeTime(m.modified_at)}
                    </Td>
                  </Tr>
                ))
              )}
            </tbody>
          </Table>
        </Panel>

        {activeDraft !== undefined ? (
          <Panel
            title={creatingNew ? "new model" : `editing · ${active ?? ""}`}
            accent
            toolbar={
              <>
                {status !== undefined ? (
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
                    {status}
                  </span>
                ) : null}
                <Button variant="outline" onClick={persist}>
                  save
                </Button>
                {!creatingNew ? (
                  <Button variant="danger" onClick={remove}>
                    delete
                  </Button>
                ) : null}
              </>
            }
          >
            <div className="space-y-5 p-5">
              <div className="corners bg-ink-700 p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bone-900">
                      Tool-call enforcement
                    </div>
                    <p className="mt-1 text-xs text-bone-500 max-w-[56ch]">
                      Validates that the model either emits a real tool call or the
                      termination flag. Fixes empty/whitespace responses and strips
                      the flag before returning. Per-model. Env defaults apply when
                      unset.
                    </p>
                  </div>
                  <Switch
                    checked={enforceConfig?.enabled === true}
                    onChange={toggleEnforce}
                    label={enforceConfig?.enabled === true ? "on" : "off"}
                  />
                </div>
                {enforceConfig?.enabled === true ? (
                  <div className="grid gap-2 text-[11px] font-mono text-bone-500">
                    <KV tone label="termination" value={enforceConfig.termination_flag ?? "(env)"} />
                    <KV tone label="max_retries" value={String(enforceConfig.max_retries ?? "(env)")} />
                    <KV tone label="empty_policy" value={enforceConfig.empty_response_policy ?? "(env)"} />
                  </div>
                ) : null}
              </div>

              <div>
                <Label htmlFor="model-json" hint="direct JSON · validated on save">
                  Model JSON
                </Label>
                <Textarea
                  id="model-json"
                  value={activeDraft.raw}
                  onChange={(event) => updateRaw(event.target.value)}
                  rows={22}
                />
              </div>
            </div>
          </Panel>
        ) : (
          <Panel title="editor" accent>
            <div className="flex h-[420px] items-center justify-center p-8 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
              select a model to edit
              <br />
              or create a new one
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}

function parseEnforce(raw: string): EnforceConfig | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const e = parsed["enforce_tool_call"];
    if (e === undefined || e === null) return undefined;
    return e as EnforceConfig;
  } catch {
    return undefined;
  }
}

function KV({
  label,
  value,
  tone = false,
}: {
  label: string;
  value: string;
  tone?: boolean;
}): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-500 py-1.5 last:border-b-0">
      <span className="text-bone-300 uppercase tracking-[0.16em] text-[10px]">{label}</span>
      <span className={tone ? "text-bone-700" : "text-bone-900"}>{value}</span>
    </div>
  );
}
