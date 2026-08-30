"use client";

import { useCallback, useEffect, useState } from "react";
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
        <ModelsBody />
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

interface HedgedRoutingConfig {
  enabled?: boolean;
  min_parallel?: number;
  max_parallel?: number;
  max_parallel_jitter?: number;
  stagger_ms?: number;
  stagger_jitter_ms?: number;
  primary_bias?: number;
  include_fallback_model_routings?: boolean;
  winner_policy?: "first_meaningful_event";
  stream_min_content_chars?: number;
  cancel_losers?: boolean;
}

interface ModelDraft {
  logical_name: string;
  raw: string;
}

function emptyModel(name: string): ModelDraft {
  return {
    logical_name: name,
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
      setActive(name);
      setDraft({ logical_name: String(payload["logical_name"] ?? name), raw: JSON.stringify(payload, null, 2) });
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
        model_routings: [{ provider: "groq", model: "", wire_protocol: "openai" }],
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
    try {
      await deleteModel(active);
      setActive(undefined);
      setDraft(undefined);
      await reload();
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
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

  function toggleHedged(enabled: boolean): void {
    if (draft === undefined) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft.raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const existing = (parsed["hedged_routing"] as HedgedRoutingConfig | undefined) ?? {};
    parsed["hedged_routing"] = enabled
      ? {
          enabled: true,
          min_parallel: existing.min_parallel ?? 2,
          max_parallel: existing.max_parallel ?? 8,
          max_parallel_jitter: existing.max_parallel_jitter ?? 0,
          stagger_ms: existing.stagger_ms ?? 250,
          stagger_jitter_ms: existing.stagger_jitter_ms ?? 0,
          primary_bias: existing.primary_bias ?? 0.65,
          include_fallback_model_routings:
            existing.include_fallback_model_routings ?? true,
          winner_policy: "first_meaningful_event",
          stream_min_content_chars: existing.stream_min_content_chars ?? 1,
          cancel_losers: existing.cancel_losers ?? true,
        }
      : { ...existing, enabled: false };
    setDraft({ ...draft, raw: JSON.stringify(parsed, null, 2) });
  }

  function patchHedged(patch: Partial<HedgedRoutingConfig>): void {
    if (draft === undefined) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft.raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const existing = (parsed["hedged_routing"] as HedgedRoutingConfig | undefined) ?? {};
    parsed["hedged_routing"] = { ...existing, ...patch };
    setDraft({ ...draft, raw: JSON.stringify(parsed, null, 2) });
  }

  function togglePartialToolCallBuffering(enabled: boolean): void {
    if (draft === undefined) return;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(draft.raw) as Record<string, unknown>;
    } catch {
      return;
    }
    parsed["buffer_partial_tool_calls"] = enabled;
    setDraft({ ...draft, raw: JSON.stringify(parsed, null, 2) });
  }

  const activeDraft = draft;
  const enforceConfig = activeDraft !== undefined ? parseEnforce(activeDraft.raw) : undefined;
  const hedgedConfig = activeDraft !== undefined ? parseHedged(activeDraft.raw) : undefined;
  const bufferPartialToolCalls =
    activeDraft !== undefined ? parseBufferPartialToolCalls(activeDraft.raw) : false;

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
                        ? "bg-phosphor-50/50 shadow-[inset_2px_0_0_0_#CDFF00]"
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

              <div className="corners bg-ink-700 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bone-900">
                      Partial tool-call buffering
                    </div>
                    <p className="mt-1 text-xs text-bone-500 max-w-[60ch]">
                      Buffers streamed tool-call deltas until the provider emits
                      a completed tool call. Keep this off for normal models and
                      enable only for strict-client compatibility problems.
                    </p>
                  </div>
                  <Switch
                    checked={bufferPartialToolCalls}
                    onChange={togglePartialToolCallBuffering}
                    label={bufferPartialToolCalls ? "on" : "off"}
                  />
                </div>
              </div>

              <div className="corners bg-ink-700 p-4">
                <div className="flex items-start justify-between gap-3 mb-3">
                  <div>
                    <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bone-900">
                      Hedged routing
                    </div>
                    <p className="mt-1 text-xs text-bone-500 max-w-[60ch]">
                      Races a biased random spread of provider/key/proxy attempts
                      and keeps the first usable response. Earlier model routes are
                      preferred, while secondary routes can win when faster.
                    </p>
                  </div>
                  <Switch
                    checked={hedgedConfig?.enabled === true}
                    onChange={toggleHedged}
                    label={hedgedConfig?.enabled === true ? "on" : "off"}
                  />
                </div>
                {hedgedConfig?.enabled === true ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <HedgedNumberField
                      label="min_parallel"
                      value={hedgedConfig.min_parallel ?? 2}
                      min={1}
                      max={30}
                      onChange={(value) => patchHedged({ min_parallel: value })}
                    />
                    <HedgedNumberField
                      label="max_parallel"
                      value={hedgedConfig.max_parallel ?? 8}
                      min={1}
                      max={30}
                      onChange={(value) => patchHedged({ max_parallel: value })}
                    />
                    <HedgedNumberField
                      label="max_parallel_jitter"
                      value={hedgedConfig.max_parallel_jitter ?? 0}
                      min={0}
                      max={20}
                      onChange={(value) => patchHedged({ max_parallel_jitter: value })}
                    />
                    <HedgedNumberField
                      label="stagger_ms"
                      value={hedgedConfig.stagger_ms ?? 250}
                      min={0}
                      max={30000}
                      onChange={(value) => patchHedged({ stagger_ms: value })}
                    />
                    <HedgedNumberField
                      label="stagger_jitter_ms"
                      value={hedgedConfig.stagger_jitter_ms ?? 0}
                      min={0}
                      max={30000}
                      onChange={(value) => patchHedged({ stagger_jitter_ms: value })}
                    />
                    <HedgedNumberField
                      label="primary_bias"
                      value={hedgedConfig.primary_bias ?? 0.65}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(value) => patchHedged({ primary_bias: value })}
                    />
                    <div className="flex items-center justify-between gap-3 bg-ink-600 px-3 py-2 md:col-span-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
                        include_fallback_model_routings
                      </span>
                      <Switch
                        checked={hedgedConfig.include_fallback_model_routings !== false}
                        onChange={(value) =>
                          patchHedged({ include_fallback_model_routings: value })
                        }
                        label={hedgedConfig.include_fallback_model_routings !== false ? "yes" : "no"}
                      />
                    </div>
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

function parseHedged(raw: string): HedgedRoutingConfig | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed["hedged_routing"];
    if (value === undefined || value === null) return undefined;
    return value as HedgedRoutingConfig;
  } catch {
    return undefined;
  }
}

function parseBufferPartialToolCalls(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed["buffer_partial_tool_calls"] === true;
  } catch {
    return false;
  }
}

function HedgedNumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <div>
      <Label htmlFor={`hedged-${label}`}>{label}</Label>
      <Input
        id={`hedged-${label}`}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        monospace
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) onChange(next);
        }}
      />
    </div>
  );
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
