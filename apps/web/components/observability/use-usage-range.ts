"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  latestIso,
  presetSince,
  readCounterStart,
  suggestedBucket,
  writeCounterStart,
  type UsageBucket,
  type UsagePreset,
} from "@/lib/usage-range";

export interface UsageRangeState {
  preset: UsagePreset;
  setPreset: (preset: UsagePreset) => void;
  customSince: string | undefined;
  customUntil: string | undefined;
  setCustomRange: (since: string | undefined, until: string | undefined) => void;
  counterStart: string | undefined;
  setCounterStart: (iso: string | undefined) => void;
  bucket: UsageBucket;
  setBucket: (bucket: UsageBucket) => void;
  /** Resolved window bounds after applying the preset and personal counter start. */
  since: string | undefined;
  until: string | undefined;
}

/** Owns the time-range selection shared by the summary tiles, trend chart,
 * breakdown, and request log so every view reflects the same window. */
export function useUsageRange(scope?: string): UsageRangeState {
  const [preset, setPresetState] = useState<UsagePreset>("7d");
  const [customSince, setCustomSince] = useState<string | undefined>(undefined);
  const [customUntil, setCustomUntil] = useState<string | undefined>(undefined);
  const [counterStart, setCounterStartState] = useState<string | undefined>(undefined);
  const [bucketOverride, setBucketOverride] = useState<UsageBucket | undefined>(undefined);

  useEffect(() => {
    setCounterStartState(readCounterStart(scope));
  }, [scope]);

  const setCounterStart = useCallback(
    (iso: string | undefined): void => {
      writeCounterStart(iso, scope);
      setCounterStartState(iso);
    },
    [scope],
  );

  const setCustomRange = useCallback((since: string | undefined, until: string | undefined): void => {
    setCustomSince(since);
    setCustomUntil(until);
    setPresetState("custom");
    setBucketOverride(undefined);
  }, []);

  const setPreset = useCallback((next: UsagePreset): void => {
    setPresetState(next);
    setBucketOverride(undefined);
  }, []);

  const setBucket = useCallback((next: UsageBucket): void => {
    setBucketOverride(next);
  }, []);

  const { since, until } = useMemo(() => {
    const presetBound = preset === "custom" ? customSince : presetSince(preset);
    return {
      since: latestIso(presetBound, counterStart),
      until: preset === "custom" ? customUntil : undefined,
    };
  }, [preset, customSince, customUntil, counterStart]);

  const bucket = bucketOverride ?? suggestedBucket(since, until);

  return {
    preset,
    setPreset,
    customSince,
    customUntil,
    setCustomRange,
    counterStart,
    setCounterStart,
    bucket,
    setBucket,
    since,
    until,
  };
}
