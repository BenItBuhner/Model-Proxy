"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ObservabilityFilters } from "@/lib/endpoints";
import { cn } from "@/lib/utils";

const DEBOUNCE_MS = 300;

export function AnalyticsFilters({
  filters,
  onChange,
}: {
  filters: ObservabilityFilters;
  onChange: (filters: ObservabilityFilters) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState({
    provider: filters.provider ?? "",
    model: filters.model ?? "",
    apiKeyEnvVar: filters.apiKeyEnvVar ?? "",
    search: filters.search ?? "",
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const committedRef = useRef(filters);

  useEffect(() => {
    committedRef.current = filters;
  }, [filters]);

  useEffect(() => {
    return () => clearTimeout(debounceRef.current);
  }, []);

  const commit = (next: ObservabilityFilters): void => {
    committedRef.current = next;
    clearTimeout(debounceRef.current);
    onChange(next);
  };

  const setField = (field: keyof typeof draft, value: string): void => {
    const nextDraft = { ...draft, [field]: value };
    setDraft(nextDraft);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      commit({ ...committedRef.current, [field]: emptyToUndefined(value) });
    }, DEBOUNCE_MS);
  };

  const clearAll = (): void => {
    setDraft({ provider: "", model: "", apiKeyEnvVar: "", search: "" });
    commit({});
  };

  const modelPreset = (model: string | undefined): void => {
    setDraft((current) => ({ ...current, model: model ?? "" }));
    commit({ ...committedRef.current, model });
  };

  return (
    <div className="grid gap-3 bg-ink-800 p-4 shadow-edge md:grid-cols-2 xl:grid-cols-5">
      <Field label="Provider">
        <Input
          value={draft.provider}
          onChange={(event) => setField("provider", event.target.value)}
          placeholder="openai"
          monospace
        />
      </Field>
      <Field label="Model">
        <Input
          value={draft.model}
          onChange={(event) => setField("model", event.target.value)}
          placeholder="gpt-4.1"
          monospace
        />
      </Field>
      <Field label="API key env">
        <Input
          value={draft.apiKeyEnvVar}
          onChange={(event) => setField("apiKeyEnvVar", event.target.value)}
          placeholder="OPENAI_API_KEY_1"
          monospace
        />
      </Field>
      <Field label="Search">
        <Input
          value={draft.search}
          onChange={(event) => setField("search", event.target.value)}
          placeholder="request/model/error"
          monospace
        />
      </Field>
      <div className="flex items-end gap-3">
        <Switch
          checked={filters.cacheHit === true}
          onChange={(next) => commit({ ...committedRef.current, cacheHit: next ? true : undefined })}
          label="cache hits"
        />
        <Button type="button" variant="ghost" onClick={clearAll}>
          clear
        </Button>
      </div>
      <div className="flex items-center gap-2 md:col-span-2 xl:col-span-5">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">quick views</span>
        <PresetChip active={filters.model === undefined} onClick={() => modelPreset(undefined)}>
          all models
        </PresetChip>
        <PresetChip active={filters.model === "fusion-beta"} onClick={() => modelPreset("fusion-beta")}>
          fusion
        </PresetChip>
      </div>
    </div>
  );
}

function PresetChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "h-7 px-2.5 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500",
        active
          ? "bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
          : "text-bone-500 hover:bg-ink-700 hover:text-bone-900",
      )}
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
