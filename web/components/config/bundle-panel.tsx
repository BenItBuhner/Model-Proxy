"use client";

import { useRef, useState } from "react";
import { clearStoredApiKey, setStoredApiKey } from "@/lib/api";
import { Badge, StatusDot } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { login } from "@/lib/endpoints";
import {
  applyBundle,
  downloadBundle,
  exportBundle,
  previewBundle,
  type BundleDiff,
  type ConfigBundle,
  type ImportConflictPolicy,
  type ImportOptions,
  type ImportReport,
} from "@/lib/bundle-api";

/**
 * Self-contained panel that combines "Download full config" (export) with
 * an "Import from file" flow that shows a dry-run diff before the operator
 * commits. Designed to drop into `/config` on the page.
 */
export function BundlePanel({
  onApplied,
}: {
  onApplied?: () => void;
}): React.ReactElement {
  const [status, setStatus] = useState<string>("idle");
  const [downloading, setDownloading] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);

  const [stagedBundle, setStagedBundle] = useState<ConfigBundle | undefined>(
    undefined,
  );
  const [stagedFilename, setStagedFilename] = useState<string>("");
  const [diff, setDiff] = useState<BundleDiff | undefined>(undefined);
  const [report, setReport] = useState<ImportReport | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const [conflictPolicy, setConflictPolicy] =
    useState<ImportConflictPolicy>("overwrite");
  const [sections, setSections] = useState<{
    providers: boolean;
    models: boolean;
    env: boolean;
  }>({ providers: true, models: true, env: true });
  const [strict, setStrict] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  function clearStaged(): void {
    setStagedBundle(undefined);
    setStagedFilename("");
    setDiff(undefined);
    setReport(undefined);
    setError(undefined);
  }

  async function handleExport(): Promise<void> {
    setDownloading(true);
    setStatus("exporting…");
    setError(undefined);
    try {
      const { bundle, filename } = await exportBundle();
      downloadBundle(bundle, filename);
      setStatus(`downloaded ${filename}`);
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    } finally {
      setDownloading(false);
    }
  }

  function currentOptions(): ImportOptions {
    return {
      conflict_policy: conflictPolicy,
      sections,
      strict,
    };
  }

  async function handleFilePicked(file: File): Promise<void> {
    clearStaged();
    setBusy(true);
    setStatus(`reading ${file.name}…`);
    try {
      const text = await file.text();
      const bundle = JSON.parse(text) as ConfigBundle;
      setStagedBundle(bundle);
      setStagedFilename(file.name);

      setStatus("computing diff…");
      const preview = await previewBundle(bundle, currentOptions());
      setDiff(preview);
      setStatus("ready");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
      setStagedBundle(undefined);
    } finally {
      setBusy(false);
      if (fileInputRef.current !== null) fileInputRef.current.value = "";
    }
  }

  async function handleRefreshPreview(): Promise<void> {
    if (stagedBundle === undefined) return;
    setBusy(true);
    setStatus("re-computing diff…");
    try {
      const preview = await previewBundle(stagedBundle, currentOptions());
      setDiff(preview);
      setStatus("ready");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }

  async function handleApply(): Promise<void> {
    if (stagedBundle === undefined) return;
    setBusy(true);
    setStatus("applying…");
    setError(undefined);
    try {
      const result = await applyBundle(stagedBundle, currentOptions());
      setReport(result);
      setStatus(result.aborted ? "aborted (strict)" : "applied");
      if (!result.aborted) {
        const nextClientKey = stagedBundle.setup.environment?.CLIENT_API_KEY;
        const clientKeyChanged =
          sections.env &&
          typeof nextClientKey === "string" &&
          nextClientKey.trim().length > 0 &&
          !result.env.skipped.includes("CLIENT_API_KEY") &&
          (result.env.add.includes("CLIENT_API_KEY") ||
            result.env.overwrite.includes("CLIENT_API_KEY"));
        if (clientKeyChanged) {
          setStatus("re-authenticating…");
          setStoredApiKey(nextClientKey.trim());
          try {
            await login(nextClientKey.trim());
          } catch {
            clearStoredApiKey();
            setError(
              "Config applied, but browser auth changed. Enter the new CLIENT_API_KEY to continue.",
            );
            setStatus("reauth required");
          }
        }
        if (onApplied !== undefined) onApplied();
      }
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }

  const hasErrors =
    (diff?.providers.errors.length ?? 0) > 0 ||
    (diff?.models.errors.length ?? 0) > 0;

  return (
    <Panel
      title="configuration bundle"
      accent
      subtitle="import / export the entire config (providers + models + env + api keys)"
      toolbar={
        <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
          <StatusDot tone={busy || downloading ? "phosphor" : "muted"} />
          {status}
        </span>
      }
    >
      <div className="space-y-5 p-5">
        {/* ---- Export ---- */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-ink-700 p-4 shadow-edge">
          <div className="space-y-1">
            <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bone-700">
              Download full config
            </div>
            <p className="max-w-[52ch] font-mono text-[11px] leading-relaxed text-bone-500">
              Produces a JSON bundle byte-compatible with the Python-era exporter.
              <span className="ml-1 text-alert-500">Contains unmasked API keys.</span>
            </p>
          </div>
          <Button onClick={handleExport} disabled={downloading}>
            {downloading ? "exporting…" : "download"}
          </Button>
        </div>

        {/* ---- Import ---- */}
        <div className="space-y-4 bg-ink-700 p-4 shadow-edge">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bone-700">
                Import from file
              </div>
              <p className="max-w-[52ch] font-mono text-[11px] leading-relaxed text-bone-500">
                Pick a bundle; a dry-run diff appears before anything is written.
                Legacy Python values (auth types, compat formats, error actions)
                are normalized automatically.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file !== undefined) void handleFilePicked(file);
                }}
              />
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={busy}
              >
                choose file…
              </Button>
              {stagedBundle !== undefined ? (
                <Button variant="ghost" onClick={clearStaged} disabled={busy}>
                  clear
                </Button>
              ) : null}
            </div>
          </div>

          {/* Options */}
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label>conflict policy</Label>
              <div className="grid grid-cols-2 gap-1">
                {(["overwrite", "skip"] as const).map((p) => {
                  const active = conflictPolicy === p;
                  return (
                    <button
                      key={p}
                      onClick={() => {
                        setConflictPolicy(p);
                        if (stagedBundle !== undefined) void handleRefreshPreview();
                      }}
                      className={
                        active
                          ? "h-8 font-mono text-[10px] uppercase tracking-[0.14em] bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                          : "h-8 font-mono text-[10px] uppercase tracking-[0.14em] bg-ink-800 text-bone-500 shadow-edge hover:text-bone-900"
                      }
                    >
                      {p}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <Label>sections</Label>
              <div className="grid grid-cols-3 gap-1">
                {(["providers", "models", "env"] as const).map((section) => {
                  const active = sections[section];
                  return (
                    <button
                      key={section}
                      onClick={() => {
                        setSections((prev) => ({ ...prev, [section]: !prev[section] }));
                        if (stagedBundle !== undefined) void handleRefreshPreview();
                      }}
                      className={
                        active
                          ? "h-8 font-mono text-[10px] uppercase tracking-[0.14em] bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                          : "h-8 font-mono text-[10px] uppercase tracking-[0.14em] bg-ink-800 text-bone-500 shadow-edge hover:text-bone-900"
                      }
                    >
                      {section}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <Label>strict mode</Label>
              <button
                onClick={() => {
                  setStrict((v) => !v);
                  if (stagedBundle !== undefined) void handleRefreshPreview();
                }}
                className={
                  strict
                    ? "h-8 w-full font-mono text-[10px] uppercase tracking-[0.14em] bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                    : "h-8 w-full font-mono text-[10px] uppercase tracking-[0.14em] bg-ink-800 text-bone-500 shadow-edge hover:text-bone-900"
                }
              >
                {strict ? "strict on" : "strict off"}
              </button>
            </div>
          </div>

          {error !== undefined ? (
            <div className="flex items-center gap-3 bg-[rgba(255,59,48,0.08)] px-4 py-2 font-mono text-[11px] shadow-[inset_0_0_0_1px_rgba(255,59,48,0.3)]">
              <StatusDot tone="danger" />
              <span className="text-alert-500">{error}</span>
            </div>
          ) : null}

          {/* Diff preview */}
          {diff !== undefined && stagedBundle !== undefined ? (
            <div className="space-y-3 bg-ink-800 p-4 shadow-edge">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bone-700">
                  preview · {stagedFilename}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="muted">v{diff.bundle_version}</Badge>
                  {hasErrors ? <Badge tone="danger">errors</Badge> : null}
                  {diff.normalizations.length > 0 ? (
                    <Badge tone="warning">
                      {diff.normalizations.length} normalized
                    </Badge>
                  ) : null}
                </div>
              </div>

              <SectionSummary label="providers" section={diff.providers} />
              <SectionSummary label="models" section={diff.models} />
              <EnvSummary diff={diff.env} />

              {diff.normalizations.length > 0 ? (
                <details className="bg-ink-700 p-3 shadow-edge">
                  <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.18em] text-bone-500 hover:text-bone-900">
                    normalizations ({diff.normalizations.length})
                  </summary>
                  <ul className="mt-2 space-y-1 font-mono text-[10px] text-bone-700">
                    {diff.normalizations.slice(0, 50).map((n, i) => (
                      <li key={i} className="truncate">
                        <span className="text-bone-300">{n.kind}</span>{" "}
                        <span className="text-phosphor-500">{n.name}</span>{" "}
                        <span className="text-bone-500">{n.path}</span>{" "}
                        <span className="text-alert-500">{String(n.from)}</span>{" "}
                        <span className="text-bone-300">→</span>{" "}
                        <span className="text-phosphor-500">{String(n.to)}</span>
                      </li>
                    ))}
                    {diff.normalizations.length > 50 ? (
                      <li className="text-bone-300">
                        …and {diff.normalizations.length - 50} more
                      </li>
                    ) : null}
                  </ul>
                </details>
              ) : null}

              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={handleRefreshPreview}
                  disabled={busy}
                >
                  refresh
                </Button>
                <Button onClick={handleApply} disabled={busy}>
                  {busy ? "applying…" : "apply"}
                </Button>
              </div>
            </div>
          ) : null}

          {/* Report */}
          {report !== undefined ? (
            <div className="space-y-2 bg-ink-800 p-4 shadow-edge">
              <div className="flex items-center justify-between">
                <div className="font-mono text-[11px] uppercase tracking-[0.18em] text-bone-700">
                  last import
                </div>
                {report.aborted ? (
                  <Badge tone="danger">aborted</Badge>
                ) : (
                  <Badge tone="phosphor">applied</Badge>
                )}
              </div>
              <div className="grid grid-cols-3 gap-3 font-mono text-[11px] text-bone-700">
                <div>
                  <div className="text-bone-300">providers</div>
                  <div className="text-phosphor-500">{report.applied.providers}</div>
                </div>
                <div>
                  <div className="text-bone-300">models</div>
                  <div className="text-phosphor-500">{report.applied.models}</div>
                </div>
                <div>
                  <div className="text-bone-300">env keys</div>
                  <div className="text-phosphor-500">{report.applied.env}</div>
                </div>
              </div>
              <div className="font-mono text-[10px] text-bone-500">
                providers → {report.paths.providers_dir}
              </div>
              <div className="font-mono text-[10px] text-bone-500">
                models → {report.paths.models_dir}
              </div>
              <div className="font-mono text-[10px] text-bone-500">
                env → {report.paths.env}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

function Label({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-bone-500">
      {children}
    </div>
  );
}

function SectionSummary({
  label,
  section,
}: {
  label: string;
  section: BundleDiff["providers"];
}): React.ReactElement {
  const totals = {
    add: section.add.length,
    overwrite: section.overwrite.length,
    unchanged: section.unchanged.length,
    errors: section.errors.length,
  };
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-700">
          {label}
        </span>
        <Counter label="add" value={totals.add} tone="phosphor" />
        <Counter label="overwrite" value={totals.overwrite} tone="warning" />
        <Counter label="unchanged" value={totals.unchanged} tone="muted" />
        {totals.errors > 0 ? (
          <Counter label="errors" value={totals.errors} tone="danger" />
        ) : null}
      </div>
      {totals.errors > 0 ? (
        <ul className="space-y-0.5 bg-[rgba(255,59,48,0.06)] px-3 py-2 font-mono text-[10px] text-alert-500">
          {section.errors.slice(0, 6).map((e, i) => (
            <li key={i} className="truncate">
              <span className="text-bone-700">{e.name}</span> · {e.error}
            </li>
          ))}
          {section.errors.length > 6 ? (
            <li className="text-bone-300">
              …and {section.errors.length - 6} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function EnvSummary({
  diff,
}: {
  diff: BundleDiff["env"];
}): React.ReactElement {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-700">
          env
        </span>
        <Counter label="add" value={diff.add.length} tone="phosphor" />
        <Counter label="overwrite" value={diff.overwrite.length} tone="warning" />
        <Counter label="unchanged" value={diff.unchanged.length} tone="muted" />
        {diff.skipped.length > 0 ? (
          <Counter label="skipped" value={diff.skipped.length} tone="muted" />
        ) : null}
      </div>
    </div>
  );
}

function Counter({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "phosphor" | "warning" | "muted" | "danger";
}): React.ReactElement {
  return (
    <Badge tone={tone}>
      {value} {label}
    </Badge>
  );
}
