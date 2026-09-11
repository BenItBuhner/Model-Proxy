"use client";
import { useEffect, type ReactNode } from "react";
import { StatusChip } from "./request-log-table";
import type { RequestLogRecord } from "@/lib/endpoints";
import { formatCount, formatDurationMs, formatUsd } from "@/lib/format";

export function RequestDetailModal({
  record,
  onClose,
}: {
  record: RequestLogRecord;
  onClose: () => void;
}): React.ReactElement {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-8">
      <button
        type="button"
        aria-label="Close request details"
        onClick={onClose}
        className="absolute inset-0 bg-ink-900/75"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Request details"
        className="corners relative flex max-h-full w-full max-w-2xl animate-flicker-in flex-col overflow-hidden bg-ink-800 shadow-[0_0_40px_rgba(0,0,0,0.55)]"
      >
        <header className="flex items-center justify-between gap-4 border-b border-ink-500 px-5 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <h2 className="shrink-0 font-mono text-[11px] uppercase tracking-[0.2em] text-bone-700">
              request details
            </h2>
            <span className="truncate font-mono text-[11px] text-bone-300">{record.requestId}</span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <StatusChip record={record} />
            <button
              type="button"
              aria-label="Close request details"
              onClick={onClose}
              className="relative h-9 w-9 shrink-0 border border-ink-300 bg-ink-700 text-bone-900 shadow-edge transition-colors hover:border-phosphor-500 hover:text-phosphor-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500"
            >
              <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
              <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
            </button>
          </div>
        </header>
        <div className="space-y-5 overflow-y-auto p-5">
          {record.errorMessage !== undefined ? (
            <div className="rounded-sm bg-[rgba(255,59,48,0.08)] p-3 font-mono text-[11px] leading-5 text-alert-500 shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
              {record.errorType ?? "Error"}: {record.errorMessage}
            </div>
          ) : null}
          <Section title="request">
            <Row label="state" value={record.state} />
            <Row label="started" value={new Date(record.timestamp).toLocaleString()} />
            <Row label="completed" value={record.completedAt !== undefined ? new Date(record.completedAt).toLocaleString() : undefined} />
            <Row label="endpoint" value={`${record.method} ${record.endpoint}`} />
            <Row label="requested model" value={record.requestedModel} />
            <Row label="wire protocol" value={record.wireProtocol} />
            <Row
              label="api key"
              value={
                record.apiKeyEnvVar !== undefined
                  ? record.keyHint !== undefined
                    ? `${record.apiKeyEnvVar} (${record.keyHint})`
                    : record.apiKeyEnvVar
                  : undefined
              }
            />
          </Section>
          <Section title="routing">
            <Row
              label="resolved route"
              value={
                record.resolvedProvider !== undefined || record.resolvedModel !== undefined
                  ? `${record.resolvedProvider ?? "-"}/${record.resolvedModel ?? "-"}`
                  : undefined
              }
            />
            <Row label="enforce mode" value={record.enforceMode ? "on" : undefined} />
            <Row label="streaming" value={record.isStreaming ? "yes" : undefined} />
            <Row label="retries" value={record.retryCount > 0 ? String(record.retryCount) : undefined} />
            <Row
              label="hedged routing"
              value={
                record.hedgedRouting === true
                  ? `${record.hedgeCandidateCount ?? 0} candidates · ${record.hedgeCancelledCount ?? 0} cancelled · ${record.hedgeFailedCount ?? 0} failed`
                  : undefined
              }
            />
          </Section>
          <Section title="usage">
            <Row label="duration" value={formatDurationMs(record.elapsedMs)} />
            <Row label="response time" value={record.responseTimeMs !== undefined ? formatDurationMs(record.responseTimeMs) : undefined} />
            <Row label="total tokens" value={record.totalTokens !== undefined ? formatCount(record.totalTokens) : undefined} />
            <Row label="prompt" value={tokenSummary(record.promptTokens, record.promptTokensEstimated)} />
            <Row label="completion" value={tokenSummary(record.completionTokens, record.completionTokensEstimated)} />
          </Section>
          <Section title="cache">
            <Row label="result" value={record.isCacheHit === undefined ? undefined : record.isCacheHit ? "hit" : "miss"} />
            <Row label="cached read" value={countOrUndefined(record.cacheReadTokens)} />
            <Row label="cache written" value={countOrUndefined(record.cacheCreationTokens)} />
            <Row label="cached tokens" value={countOrUndefined(record.cachedTokens)} />
            <Row label="matched" value={countOrUndefined(record.matchedTokens)} />
            <Row label="since last match" value={record.msSinceLastMatch !== undefined ? formatDurationMs(record.msSinceLastMatch) : undefined} />
          </Section>
          <Section title="cost">
            <Row label="cost" value={record.userCostUsd !== undefined ? formatUsd(record.userCostUsd) : undefined} />
            <Row label="typical" value={record.typicalCostUsd !== undefined ? formatUsd(record.typicalCostUsd) : undefined} />
            <Row label="saved" value={record.savedCostUsd !== undefined ? formatUsd(record.savedCostUsd) : undefined} />
          </Section>
          <Section title="stream">
            <Row label="chunks" value={countOrUndefined(record.streamChunkCount)} />
            <Row label="bytes" value={countOrUndefined(record.streamBytes)} />
          </Section>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): React.ReactElement {
  return (
    <section className="space-y-1.5">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.18em] text-phosphor-500">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string | number | undefined }): React.ReactElement | null {
  if (value === undefined || value === "") return null;
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-[11px] text-bone-700">{value}</span>
    </div>
  );
}

function countOrUndefined(value: number | undefined): string | undefined {
  return value === undefined ? undefined : formatCount(value);
}

function tokenSummary(tokens: number | undefined, estimated: boolean | undefined): string | undefined {
  if (tokens === undefined) return undefined;
  return `${formatCount(tokens)}${estimated === true ? " (est)" : ""}`;
}
