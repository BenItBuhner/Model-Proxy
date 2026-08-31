"use client";

import { useMemo } from "react";
import type { AnalyticsSummary } from "@/lib/endpoints";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import { formatCount, formatUsd } from "@/lib/format";

type ProviderModelRow = AnalyticsSummary["byProviderKey"][number];

export function UsageBreakdownTable({
  summary,
}: {
  summary: AnalyticsSummary | undefined;
}): React.ReactElement {
  const rows = useMemo(() => aggregateByProviderModel(summary?.byProviderKey ?? []), [summary]);

  return (
    <Table>
      <Thead>
        <Tr>
          <Th>Provider</Th>
          <Th>Model</Th>
          <Th align="right" width="9ch">
            Reqs
          </Th>
          <Th align="right" width="13ch">
            Tokens
          </Th>
          <Th align="right" width="12ch">
            Spend
          </Th>
          <Th align="right" width="12ch">
            Saved
          </Th>
          <Th align="right" width="13ch">
            Cache
          </Th>
        </Tr>
      </Thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyRow colSpan={7}>no route breakdown yet</EmptyRow>
        ) : (
          rows.map((row) => (
            <Tr key={`${row.provider}|${row.model}`}>
              <Td className="text-bone-900">{row.provider}</Td>
              <Td className="text-bone-700">{row.model}</Td>
              <Td align="right" className="text-bone-500">
                {formatCount(row.requests)}
              </Td>
              <Td align="right" className="text-bone-500">
                <CellSub
                  value={formatCount(row.totalTokens)}
                  sub={`${formatCount(row.promptTokens)} in · ${formatCount(row.completionTokens)} out`}
                />
              </Td>
              <Td align="right" className="text-bone-700">
                {formatUsd(row.userCostUsd)}
              </Td>
              <Td align="right" className="text-phosphor-500">
                {formatUsd(row.savedCostUsd)}
              </Td>
              <Td align="right" className="text-bone-500">
                <CellSub
                  value={formatCount(row.cacheReadTokens + row.cacheCreationTokens)}
                  sub={`${formatCount(row.cacheHits)} hits`}
                />
              </Td>
            </Tr>
          ))
        )}
      </tbody>
    </Table>
  );
}

function aggregateByProviderModel(rows: ProviderModelRow[]): ProviderModelRow[] {
  const merged = new Map<string, ProviderModelRow>();
  for (const row of rows) {
    const current = merged.get(`${row.provider}|${row.model}`);
    if (current === undefined) {
      merged.set(`${row.provider}|${row.model}`, { ...row });
      continue;
    }
    current.requests += row.requests;
    current.promptTokens += row.promptTokens;
    current.completionTokens += row.completionTokens;
    current.totalTokens += row.totalTokens;
    current.cacheReadTokens += row.cacheReadTokens;
    current.cacheCreationTokens += row.cacheCreationTokens;
    current.matchedTokens += row.matchedTokens;
    current.cacheHits += row.cacheHits;
    current.userCostUsd += row.userCostUsd;
    current.typicalCostUsd += row.typicalCostUsd;
    current.savedCostUsd += row.savedCostUsd;
  }
  return Array.from(merged.values()).sort((a, b) => b.requests - a.requests);
}

function CellSub({ value, sub }: { value: string; sub: string }): React.ReactElement {
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{value}</span>
      <span className="text-[10px] text-bone-300">{sub}</span>
    </span>
  );
}
