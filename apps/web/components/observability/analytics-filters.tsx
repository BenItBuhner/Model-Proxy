"use client";

import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { ObservabilityFilters } from "@/lib/endpoints";

export function AnalyticsFilters({
  filters,
  onChange,
}: {
  filters: ObservabilityFilters;
  onChange: (filters: ObservabilityFilters) => void;
}): React.ReactElement {
  return (
    <div className="grid gap-3 bg-ink-800 p-4 shadow-edge md:grid-cols-2 xl:grid-cols-5">
      <Field label="Provider">
        <Input
          value={filters.provider ?? ""}
          onChange={(event) => onChange({ ...filters, provider: emptyToUndefined(event.target.value) })}
          placeholder="openai"
          monospace
        />
      </Field>
      <Field label="Model">
        <Input
          value={filters.model ?? ""}
          onChange={(event) => onChange({ ...filters, model: emptyToUndefined(event.target.value) })}
          placeholder="gpt-4.1"
          monospace
        />
      </Field>
      <Field label="API key env">
        <Input
          value={filters.apiKeyEnvVar ?? ""}
          onChange={(event) => onChange({ ...filters, apiKeyEnvVar: emptyToUndefined(event.target.value) })}
          placeholder="OPENAI_API_KEY_1"
          monospace
        />
      </Field>
      <Field label="Search">
        <Input
          value={filters.search ?? ""}
          onChange={(event) => onChange({ ...filters, search: emptyToUndefined(event.target.value) })}
          placeholder="request/model/error"
          monospace
        />
      </Field>
      <div className="flex items-end gap-3">
        <Switch
          checked={filters.cacheHit === true}
          onChange={(next) => onChange({ ...filters, cacheHit: next ? true : undefined })}
          label="cache hits"
        />
        <Button type="button" variant="ghost" onClick={() => onChange({})}>
          clear
        </Button>
      </div>
    </div>
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
