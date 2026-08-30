import { describe, expect, test } from "bun:test";

import { mergeAbortSignals, sleep } from "../src/shared/utils.ts";

describe("sleep", () => {
  test("resolves after the timer without a signal", async () => {
    await sleep(1);
  });

  test("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = performance.now();
    await expect(sleep(5_000, controller.signal)).rejects.toThrow("Aborted");
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("rejects when the signal aborts mid-sleep", async () => {
    const controller = new AbortController();
    const pending = sleep(5_000, controller.signal);
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow("Aborted");
  });
});

describe("mergeAbortSignals", () => {
  test("returns undefined for no signals", () => {
    expect(mergeAbortSignals(undefined, undefined)).toBeUndefined();
  });

  test("aborts when any input aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const merged = mergeAbortSignals(a.signal, b.signal);
    expect(merged?.aborted).toBe(false);
    b.abort();
    expect(merged?.aborted).toBe(true);
  });

  test("is aborted immediately when an input is already aborted", () => {
    const a = new AbortController();
    a.abort();
    const merged = mergeAbortSignals(a.signal, new AbortController().signal);
    expect(merged?.aborted).toBe(true);
  });
});
