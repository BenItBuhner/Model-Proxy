"use client";

import { useState } from "react";
import { EventTimeline } from "@/components/test/event-timeline";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody } from "@/components/ui/panel";
import { getStoredCompletion, type RequestLogRecord } from "@/lib/endpoints";
import type { RequestEvent } from "@/lib/test-events";
import { truncate } from "@/lib/utils";
import { formatCount, formatDurationMs, formatUsd } from "./metric-widget";

export interface RequestTrace {
  requestId: string;
  finished: boolean;
  startedAt: string;
  events: RequestEvent[];
}

export function RequestDetailPanel({
  record,
  trace,
  loadingTrace,
}: {
  record: RequestLogRecord | undefined;
  trace: RequestTrace | undefined;
  loadingTrace: boolean;
}): React.ReactElement {
  const [completionPreview, setCompletionPreview] = useState<string | undefined>(undefined);
  const [completionError, setCompletionError] = useState<string | undefined>(undefined);

  const loadCompletion = async (): Promise<void> => {
    if (record === undefined) return;
    try {
      const result = await getStoredCompletion(record.requestId);
      setCompletionPreview(JSON.stringify(result.completion, null, 2).slice(0, 4000));
      setCompletionError(undefined);
    } catch (err) {
      setCompletionPreview(undefined);
      setCompletionError((err as Error).message);
    }
  };

  return (
    <div className="flex min-h-0 flex-col gap-5">
      <Panel
        title="selected request"
        subtitle={record !== undefined ? truncate(record.requestId, 18) : "none"}
        accent
        toolbar={loadingTrace ? <Badge tone="muted">loading</Badge> : undefined}
      >
        <PanelBody className="space-y-3">
          {record === undefined ? (
            <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-bone-300">
              select a request to inspect routing decisions
            </div>
          ) : (
            <>
              <KV label="Request ID" value={record.requestId} />
              <KV label="State" value={record.state} />
              <KV label="Endpoint" value={`${record.method} ${record.endpoint}`} />
              <KV label="Route" value={`${record.resolvedProvider ?? "-"}/${record.resolvedModel ?? "-"}`} />
              <KV label="API key" value={record.apiKeyEnvVar ?? "-"} />
              <KV label="Duration" value={formatDurationMs(record.elapsedMs)} />
              <KV label="Tokens" value={formatCount(record.totalTokens)} />
              <KV label="Saved" value={`${formatUsd(record.savedCostUsd)} (${formatUsd(record.typicalCostUsd)} typical)`} />
              <KV label="Cache" value={record.isCacheHit === true ? `${formatCount(record.matchedTokens)} matched` : "miss"} />
              {record.errorMessage !== undefined ? (
                <div className="rounded-sm bg-[rgba(255,59,48,0.08)] p-3 font-mono text-[11px] leading-5 text-alert-500 shadow-[inset_0_0_0_1px_rgba(255,59,48,0.18)]">
                  {record.errorType ?? "Error"}: {record.errorMessage}
                </div>
              ) : null}
              <Button type="button" variant="outline" size="sm" onClick={() => void loadCompletion()}>
                load stored completion
              </Button>
              {completionError !== undefined ? (
                <div className="font-mono text-[11px] text-alert-500">{completionError}</div>
              ) : null}
              {completionPreview !== undefined ? (
                <pre className="max-h-64 overflow-auto bg-ink-900 p-3 font-mono text-[10px] leading-5 text-bone-500 shadow-edge">
                  {completionPreview}
                </pre>
              ) : null}
            </>
          )}
        </PanelBody>
      </Panel>

      <Panel title="verbose event trace" accent className="min-h-0 flex-1" bodyClassName="h-[520px]">
        <EventTimeline events={trace?.events ?? []} live={trace?.finished === false} onClear={() => undefined} />
      </Panel>
    </div>
  );
}

function KV({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
        {label}
      </span>
      <span className="min-w-0 break-all text-right font-mono text-[11px] text-bone-700">
        {value}
      </span>
    </div>
  );
}
