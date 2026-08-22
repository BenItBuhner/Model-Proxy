"use client";

import { Badge } from "@/components/ui/badge";
import { EmptyRow, Table, Td, Th, Thead, Tr } from "@/components/ui/table";
import type { RequestLogRecord } from "@/lib/endpoints";
import { formatRelativeTime, truncate } from "@/lib/utils";
import { formatCount, formatDurationMs, formatUsd } from "./metric-widget";

export function RequestLogTable({
  records,
  selectedId,
  onSelect,
}: {
  records: RequestLogRecord[];
  selectedId: string | undefined;
  onSelect: (requestId: string) => void;
}): React.ReactElement {
  return (
    <Table>
      <Thead>
        <Tr>
          <Th width="13ch">When</Th>
          <Th>Request</Th>
          <Th>Route</Th>
          <Th align="right" width="10ch">Duration</Th>
          <Th align="right" width="10ch">Tokens</Th>
          <Th align="right" width="11ch">Saved</Th>
          <Th align="center" width="11ch">Cache</Th>
          <Th align="center" width="13ch">Status</Th>
        </Tr>
      </Thead>
      <tbody>
        {records.length === 0 ? (
          <EmptyRow colSpan={8}>no requests recorded</EmptyRow>
        ) : (
          records.map((record) => (
            <Tr
              key={record.requestId}
              onClick={() => onSelect(record.requestId)}
              className={[
                record.state === "running" ? "bg-phosphor-50/40" : "",
                selectedId === record.requestId ? "bg-ink-700/80" : "",
              ].join(" ")}
            >
              <Td className="text-bone-300">{formatRelativeTime(record.timestamp)}</Td>
              <Td>
                <div className="text-bone-900">{truncate(record.requestedModel, 34)}</div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-bone-300">
                  {record.method} {record.endpoint.replace(/^\/v1\//, "")}
                </div>
              </Td>
              <Td>
                <div className="text-bone-700">
                  {record.resolvedProvider ?? "-"}
                  <span className="text-bone-300">/</span>
                  {truncate(record.resolvedModel ?? "-", 28)}
                </div>
                <div className="mt-1 text-[10px] uppercase tracking-[0.14em] text-bone-300">
                  {record.apiKeyEnvVar ?? "-"}
                </div>
              </Td>
              <Td align="right" className="text-bone-500">{formatDurationMs(record.elapsedMs)}</Td>
              <Td align="right" className="text-bone-500">{formatCount(record.totalTokens)}</Td>
              <Td align="right" className="text-bone-500">{formatUsd(record.savedCostUsd)}</Td>
              <Td align="center">
                {record.isCacheHit === true ? <Badge tone="phosphor">hit</Badge> : <Badge tone="muted">miss</Badge>}
              </Td>
              <Td align="center">
                <StatusChip record={record} />
              </Td>
            </Tr>
          ))
        )}
      </tbody>
    </Table>
  );
}

function StatusChip({ record }: { record: RequestLogRecord }): React.ReactElement {
  const status = record.responseStatus;
  if (record.state === "running") return <Badge tone="phosphor">running</Badge>;
  if (status === undefined) return <Badge tone="muted">pending</Badge>;
  if (status >= 500) return <Badge tone="danger">{status}</Badge>;
  if (status >= 400) return <Badge tone="warning">{status}</Badge>;
  if (record.errorType !== undefined) return <Badge tone="warning">{status}</Badge>;
  if (record.retryCount > 0) return <Badge tone="warning">{status} retry</Badge>;
  return record.enforceMode ? <Badge tone="phosphor">{status} enforce</Badge> : <Badge tone="bone">{status}</Badge>;
}
