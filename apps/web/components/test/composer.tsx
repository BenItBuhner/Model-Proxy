"use client";

import { useEffect, useState } from "react";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { listModels, type ModelListItem } from "@/lib/endpoints";
import type {
  EnforceOverride,
  ParamState,
  Protocol,
} from "@/lib/test-session";

interface ComposerProps {
  protocol: Protocol;
  onProtocolChange: (protocol: Protocol) => void;
  logicalModel: string;
  onLogicalModelChange: (model: string) => void;
  params: ParamState;
  onParamsChange: (next: ParamState) => void;
  busy: boolean;
}

export function Composer(props: ComposerProps): React.ReactElement {
  const [models, setModels] = useState<ModelListItem[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    listModels()
      .then((result) => {
        if (cancelled) return;
        setModels(result.models);
        if (props.logicalModel.length === 0 && result.models.length > 0) {
          const first = result.models[0];
          if (first !== undefined) props.onLogicalModelChange(first.logical_name);
        }
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function updateParam<K extends keyof ParamState>(
    key: K,
    value: ParamState[K],
  ): void {
    props.onParamsChange({ ...props.params, [key]: value });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-auto p-5 space-y-5">
        {/* Protocol */}
        <div>
          <Label>Wire protocol</Label>
          <div className="grid grid-cols-2 gap-2">
            {(["openai", "anthropic"] as const).map((p) => {
              const active = props.protocol === p;
              return (
                <button
                  key={p}
                  onClick={() => props.onProtocolChange(p)}
                  className={
                    active
                      ? "h-9 font-mono text-[11px] uppercase tracking-[0.14em] bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                      : "h-9 font-mono text-[11px] uppercase tracking-[0.14em] bg-ink-700 text-bone-500 shadow-edge hover:text-bone-900"
                  }
                >
                  {p === "openai" ? "OpenAI /v1/chat" : "Anthropic /v1/messages"}
                </button>
              );
            })}
          </div>
        </div>

        {/* Model */}
        <div>
          <Label hint={error !== undefined ? error : `${models.length} available`}>
            Logical model
          </Label>
          <select
            value={props.logicalModel}
            onChange={(e) => props.onLogicalModelChange(e.target.value)}
            className="h-9 w-full bg-ink-700 px-3 text-sm text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
          >
            {props.logicalModel.length === 0 ? <option value="">— pick a model —</option> : null}
            {models.map((m) => (
              <option key={m.logical_name} value={m.logical_name}>
                {m.logical_name}
              </option>
            ))}
          </select>
        </div>

        <div className="hairline" />

        {/* Parameters */}
        <div className="space-y-3">
          <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
            Sampling
          </div>
          <div className="grid grid-cols-2 gap-3">
            <ParamInput
              label="temperature"
              value={props.params.temperature}
              step={0.05}
              min={0}
              max={2}
              onChange={(v) => updateParam("temperature", v)}
            />
            <ParamInput
              label="top_p"
              value={props.params.top_p}
              step={0.05}
              min={0}
              max={1}
              onChange={(v) => updateParam("top_p", v)}
            />
            <ParamInput
              label="max_tokens"
              value={props.params.max_tokens}
              step={1}
              min={1}
              onChange={(v) => updateParam("max_tokens", v)}
              int
            />
            <ParamInput
              label="presence"
              value={props.params.presence_penalty}
              step={0.1}
              min={-2}
              max={2}
              onChange={(v) => updateParam("presence_penalty", v)}
              hideOnAnthropic={props.protocol === "anthropic"}
            />
            <ParamInput
              label="frequency"
              value={props.params.frequency_penalty}
              step={0.1}
              min={-2}
              max={2}
              onChange={(v) => updateParam("frequency_penalty", v)}
              hideOnAnthropic={props.protocol === "anthropic"}
            />
          </div>
        </div>

        <div>
          <Label>Stop sequences (one per line)</Label>
          <textarea
            rows={3}
            value={(props.params.stop ?? []).join("\n")}
            onChange={(e) =>
              updateParam(
                "stop",
                e.target.value
                  .split("\n")
                  .map((s) => s.trimEnd())
                  .filter((s) => s.length > 0),
              )
            }
            className="max-h-28 min-h-[4.5rem] w-full resize-y bg-ink-700 px-3 py-2 text-sm text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
          />
        </div>

        {props.protocol === "anthropic" ? (
          <div>
            <Label>System prompt (Anthropic only)</Label>
            <textarea
              rows={3}
              value={props.params.system ?? ""}
              onChange={(e) => updateParam("system", e.target.value)}
              className="w-full bg-ink-700 px-3 py-2 text-sm text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none font-mono"
            />
          </div>
        ) : null}

        <div className="hairline" />

        {/* Toggles */}
        <div className="space-y-4">
          <Switch
            label="Streaming"
            hint={props.params.stream ? "SSE / incremental" : "wait for full response"}
            checked={props.params.stream}
            onChange={(v) => updateParam("stream", v)}
          />
          {props.protocol === "openai" ? (
            <Switch
              label="response_format = json_object"
              hint="some providers require 'json' in prompt"
              checked={props.params.response_format_json === true}
              onChange={(v) => updateParam("response_format_json", v)}
            />
          ) : null}

          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-500 pb-1.5 flex items-center justify-between">
              <span>Enforce tool-call (this request)</span>
              {props.params.enforceOverride !== "default" ? (
                <Badge tone="phosphor">override</Badge>
              ) : null}
            </div>
            <div className="grid grid-cols-3 gap-1">
              {(
                [
                  { key: "default", label: "Default" },
                  { key: "force-on", label: "Force ON" },
                  { key: "force-off", label: "Force OFF" },
                ] as Array<{ key: EnforceOverride; label: string }>
              ).map((opt) => {
                const active = props.params.enforceOverride === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => updateParam("enforceOverride", opt.key)}
                    className={
                      active
                        ? "h-8 font-mono text-[10px] uppercase tracking-[0.14em] bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                        : "h-8 font-mono text-[10px] uppercase tracking-[0.14em] bg-ink-700 text-bone-500 shadow-edge hover:text-bone-900"
                    }
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ParamInput({
  label,
  value,
  step,
  min,
  max,
  onChange,
  int = false,
  hideOnAnthropic = false,
}: {
  label: string;
  value: number | undefined;
  step: number;
  min?: number;
  max?: number;
  onChange: (v: number | undefined) => void;
  int?: boolean;
  hideOnAnthropic?: boolean;
}): React.ReactElement | null {
  if (hideOnAnthropic) return null;
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        step={step}
        min={min}
        max={max}
        monospace
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(undefined);
          const parsed = int ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
          onChange(Number.isFinite(parsed) ? parsed : undefined);
        }}
      />
    </div>
  );
}
