"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Panel } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge, StatusDot } from "@/components/ui/badge";
import { getEnv, saveEnv, type EnvEntry } from "@/lib/endpoints";

interface RowDraft {
  key: string;
  value: string;
  masked: boolean;
  touched: boolean;
}

export function EnvBody({ embedded = false }: { embedded?: boolean }): React.ReactElement {
  const [rows, setRows] = useState<RowDraft[]>([]);
  const [path, setPath] = useState<string>("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [revealed, setRevealed] = useState<boolean>(false);

  const load = useCallback(async () => {
    try {
      const result = await getEnv(revealed);
      setPath(result.path);
      setRows(
        result.entries.map((entry: EnvEntry) => ({
          key: entry.key,
          value: entry.value,
          masked: entry.masked,
          touched: false,
        })),
      );
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [revealed]);

  const dirtyRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = rows.some((row) => row.touched);
  }, [rows]);

  useEffect(() => {
    void load();
    const id = setInterval(() => {
      if (!dirtyRef.current) void load();
    }, 5000);
    return () => clearInterval(id);
  }, [load]);

  function updateRow(index: number, patch: Partial<RowDraft>): void {
    setRows((prev) => {
      const next = [...prev];
      const prevRow = next[index];
      if (prevRow === undefined) return prev;
      next[index] = { ...prevRow, ...patch, touched: true };
      return next;
    });
  }

  function addRow(): void {
    setRows((prev) => [
      ...prev,
      { key: "", value: "", masked: false, touched: true },
    ]);
  }

  function removeRow(index: number): void {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function persist(): Promise<void> {
    setStatus("saving…");
    try {
      const entries = rows
        .filter((r) => r.key.trim().length > 0)
        .map((r) => ({ key: r.key.trim(), value: r.value }));
      const result = await saveEnv(entries);
      setStatus(
        result.skipped.length > 0
          ? `saved · ${result.applied} applied · ${result.skipped.length} skipped`
          : `saved · ${result.applied} applied`,
      );
      await load();
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  }

  const total = rows.length;

  const actions = (
    <>
      <Button variant="outline" onClick={() => setRevealed((v) => !v)}>
        {revealed ? "hide secrets" : "reveal secrets"}
      </Button>
      <Button variant="outline" onClick={addRow}>
        + row
      </Button>
      <Button onClick={persist}>save</Button>
    </>
  );

  return (
    <>
      {embedded ? (
        <div className="mb-6 flex flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : (
        <PageHeader
          eyebrow="environment"
          title="Runtime variables"
          description="Read-write access to the runtime .env file. Changes persist to disk and apply live without a restart."
          actions={actions}
        />
      )}

      {error !== undefined ? (
        <div className="mb-6 flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-3 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
          <StatusDot tone="danger" />
          <span className="text-alert-500">{error}</span>
        </div>
      ) : null}

      <Panel
        title={`env (${total})`}
        accent
        subtitle={path}
        toolbar={
          status !== undefined ? (
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
              {status}
            </span>
          ) : null
        }
      >
        <div className="divide-y divide-ink-500">
          {rows.length === 0 ? (
            <div className="p-12 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
              no entries · click + row to add
            </div>
          ) : (
            rows.map((row, index) => (
              <div
                key={index}
                className="grid grid-cols-[minmax(0,3fr)_minmax(0,6fr)_auto] items-center gap-3 px-5 py-3"
              >
                <Input
                  value={row.key}
                  onChange={(event) => updateRow(index, { key: event.target.value.toUpperCase() })}
                  placeholder="VAR_NAME"
                  monospace
                />
                <div className="relative">
                  <Input
                    value={row.value}
                    onChange={(event) => updateRow(index, { value: event.target.value })}
                    placeholder={row.masked ? "(value hidden)" : "value"}
                    monospace
                    type={row.masked && !revealed ? "password" : "text"}
                  />
                  {row.masked && !revealed ? (
                    <span className="absolute right-2 top-1/2 -translate-y-1/2">
                      <Badge tone="warning">secret</Badge>
                    </span>
                  ) : null}
                </div>
                <button
                  onClick={() => removeRow(index)}
                  className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300 transition-colors hover:text-alert-500"
                  title="remove row"
                >
                  remove
                </button>
              </div>
            ))
          )}
        </div>
      </Panel>
    </>
  );
}
