"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Panel, PanelBody } from "@/components/ui/panel";
import { getCurrentUserLogs, type RequestLogRecord } from "@/lib/endpoints";
import { formatCount } from "@/lib/format";
import { RequestDetailModal } from "./request-detail-modal";
import { RequestLogTable } from "./request-log-table";

const REQUEST_LIMIT = 1000;
const POLL_MS = 4000;

export function UserRequestHistory(): React.ReactElement {
  const [records, setRecords] = useState<RequestLogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [completed, setCompleted] = useState(0);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const selectedSnapshotRef = useRef<RequestLogRecord | undefined>(undefined);
  const sequenceRef = useRef(0);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(false);

  const reload = useCallback(async (): Promise<void> => {
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    inFlightRef.current = true;
    const sequence = ++sequenceRef.current;
    try {
      const logs = await getCurrentUserLogs(REQUEST_LIMIT);
      if (sequence !== sequenceRef.current) return;
      setRecords(logs.records);
      setTotal(logs.total);
      setCompleted(logs.total_completed);
      setActive(logs.active_count);
      setError(undefined);
    } catch (err) {
      if (sequence !== sequenceRef.current) return;
      setError((err as Error).message);
    } finally {
      inFlightRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void reload();
      }
    }
  }, []);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(id);
  }, [reload]);

  const selected = useMemo(() => {
    if (selectedId === undefined) return undefined;
    const current = records.find((record) => record.requestId === selectedId);
    return current ?? selectedSnapshotRef.current;
  }, [records, selectedId]);
  useEffect(() => {
    if (selected !== undefined) selectedSnapshotRef.current = selected;
  }, [selected]);

  return (
    <Panel
      title="request history"
      subtitle={`${formatCount(total)} requests · ${formatCount(completed)} completed · ${formatCount(active)} running`}
      accent
      toolbar={
        <div className="flex items-center gap-3">
          <span
            className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-phosphor-500"
            title="auto-refreshes every 4 seconds"
          >
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-phosphor-500 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-phosphor-500" />
            </span>
            live
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => void reload()}>
            refresh
          </Button>
        </div>
      }
    >
      <PanelBody>
        {error !== undefined ? <div className="mb-3 text-alert-500">{error}</div> : null}
        <RequestLogTable records={records} selectedId={selectedId} onSelect={setSelectedId} />
      </PanelBody>
      {selected !== undefined ? <RequestDetailModal record={selected} onClose={() => setSelectedId(undefined)} /> : null}
    </Panel>
  );
}
