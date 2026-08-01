import { describe, expect, test } from "bun:test";

import {
  fillTimeseriesGaps,
  latestIso,
  mergeUsageFilters,
  presetSince,
  suggestedBucket,
} from "../web/lib/usage-range.ts";

describe("usage range helpers", () => {
  test("presetSince computes relative windows", () => {
    const now = new Date("2026-08-01T12:00:00.000Z");
    expect(presetSince("24h", now)).toBe("2026-07-31T12:00:00.000Z");
    expect(presetSince("7d", now)).toBe("2026-07-25T12:00:00.000Z");
    expect(presetSince("all", now)).toBeUndefined();
  });

  test("mergeUsageFilters applies counter floor over preset since", () => {
    const filters = mergeUsageFilters({
      preset: "7d",
      counterStart: "2026-07-30T00:00:00.000Z",
    });
    expect(filters.since).toBe("2026-07-30T00:00:00.000Z");
  });

  test("suggestedBucket prefers hour for short windows", () => {
    expect(suggestedBucket("2026-08-01T00:00:00.000Z", "2026-08-01T12:00:00.000Z")).toBe("hour");
    expect(suggestedBucket("2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z")).toBe("day");
  });

  test("latestIso picks the later timestamp", () => {
    expect(latestIso("2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z")).toBe(
      "2026-02-01T00:00:00.000Z",
    );
  });

  test("fillTimeseriesGaps zero-fills missing hour buckets", () => {
    const filled = fillTimeseriesGaps(
      [
        {
          bucket: "2026-08-01T10:00:00.000Z",
          requests: 2,
          totalTokens: 20,
          userCostUsd: 0.1,
          typicalCostUsd: 0.2,
          savedCostUsd: 0.1,
        },
      ],
      {
        since: "2026-08-01T09:00:00.000Z",
        until: "2026-08-01T11:30:00.000Z",
        bucket: "hour",
        createEmpty: (bucket) => ({
          bucket,
          requests: 0,
          totalTokens: 0,
          userCostUsd: 0,
          typicalCostUsd: 0,
          savedCostUsd: 0,
        }),
      },
    );
    expect(filled.map((point) => point.bucket)).toEqual([
      "2026-08-01T09:00:00.000Z",
      "2026-08-01T10:00:00.000Z",
      "2026-08-01T11:00:00.000Z",
    ]);
    expect(filled[0]?.requests).toBe(0);
    expect(filled[1]?.requests).toBe(2);
  });
});
