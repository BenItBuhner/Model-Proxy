"use client";

import type { AnalyticsSummary } from "@/lib/endpoints";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import { formatCount, formatUsd } from "@/lib/format";

export function UsageBreakdownTable({
  summary,
}: {
  summary: AnalyticsSummary | undefined;
}): React.ReactElement {
  const rows = summary?.byProviderKey ?? [];

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
            <Tr key={`${row.provider}|${row.apiKeyEnvVar}|${row.model}`}>
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

function CellSub({ value, sub }: { value: string; sub: string }): React.ReactElement {
  return (
    <span className="inline-flex flex-col items-end leading-tight">
      <span>{value}</span>
      <span className="text-[10px] text-bone-300">{sub}</span>
    </span>
  );
}
