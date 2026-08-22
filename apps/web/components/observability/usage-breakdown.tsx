"use client";

import type { AnalyticsSummary } from "@/lib/endpoints";
import { Table, Thead, Tr, Th, Td, EmptyRow } from "@/components/ui/table";
import { formatCount, formatUsd } from "./metric-widget";

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
          <Th>Key</Th>
          <Th align="right" width="9ch">
            Reqs
          </Th>
          <Th align="right" width="11ch">
            Tokens
          </Th>
          <Th align="right" width="12ch">
            Spend
          </Th>
          <Th align="right" width="12ch">
            Saved
          </Th>
          <Th align="right" width="9ch">
            Cache
          </Th>
        </Tr>
      </Thead>
      <tbody>
        {rows.length === 0 ? (
          <EmptyRow colSpan={8}>no route breakdown yet</EmptyRow>
        ) : (
          rows.map((row) => (
            <Tr key={`${row.provider}|${row.apiKeyEnvVar}|${row.model}`}>
              <Td className="text-bone-900">{row.provider}</Td>
              <Td className="text-bone-700">{row.model}</Td>
              <Td className="text-bone-300">{row.apiKeyEnvVar}</Td>
              <Td align="right" className="text-bone-500">
                {formatCount(row.requests)}
              </Td>
              <Td align="right" className="text-bone-500">
                {formatCount(row.totalTokens)}
              </Td>
              <Td align="right" className="text-bone-700">
                {formatUsd(row.userCostUsd)}
              </Td>
              <Td align="right" className="text-phosphor-500">
                {formatUsd(row.savedCostUsd)}
              </Td>
              <Td align="right" className="text-bone-500">
                {formatCount(row.cacheHits)}
              </Td>
            </Tr>
          ))
        )}
      </tbody>
    </Table>
  );
}
