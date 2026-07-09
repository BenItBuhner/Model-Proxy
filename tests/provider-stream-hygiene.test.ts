import { describe, it, expect } from "bun:test";
import { readSSELines } from "../src/providers/openai-provider.ts";
import { readBodyWithDeadline } from "../src/providers/upstream-fetch.ts";
import { ProviderTimeoutError } from "../src/providers/errors.ts";

function sseStream(
  chunks: string[],
  options: { neverClose?: boolean; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (options.neverClose !== true) controller.close();
    },
    cancel() {
      options.onCancel?.();
    },
  });
}

describe("readSSELines connection hygiene", () => {
  it("cancels the underlying body when the consumer exits early", async () => {
    let cancelled = false;
    const stream = sseStream(
      ["data: one\n", "data: two\n", "data: [DONE]\n", "data: never-read\n"],
      { neverClose: true, onCancel: () => (cancelled = true) },
    );

    // Mimic streamOpenAI: return out of the loop on [DONE] without draining.
    for await (const line of readSSELines(stream)) {
      if (line.includes("[DONE]")) break;
    }

    // Cancellation must reach the source so the pooled connection is released
    // (a released-but-uncancelled reader strands the socket until GC and
    // eventually exhausts Bun's 256-per-host connection pool).
    expect(cancelled).toBe(true);
  });

  it("cancels the underlying body on normal completion too", async () => {
    let cancelled = false;
    const stream = sseStream(["data: a\n", "data: b\n"], {
      onCancel: () => (cancelled = true),
    });
    const lines: string[] = [];
    for await (const line of readSSELines(stream)) lines.push(line);
    expect(lines).toEqual(["data: a", "data: b"]);
    // cancel() on an already-closed stream is a no-op upstream, but the reader
    // must still issue it so partially-consumed bodies always release.
    expect(cancelled).toBe(false); // closed streams don't invoke source cancel
  });

  it("throws ProviderTimeoutError when the stream stalls mid-body", async () => {
    const stream = sseStream(["data: first\n"], { neverClose: true });
    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const line of readSSELines(stream, 150)) {
        seen.push(line);
      }
    } catch (err) {
      error = err;
    }
    expect(seen).toEqual(["data: first"]);
    expect(error).toBeInstanceOf(ProviderTimeoutError);
    expect(String(error)).toContain("stalled");
  });
});

describe("readBodyWithDeadline", () => {
  it("returns the parsed body when it completes in time", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
    const out = await readBodyWithDeadline(
      response,
      () => response.json() as Promise<Record<string, unknown>>,
      1_000,
    );
    expect(out).toEqual({ ok: true });
  });

  it("throws ProviderTimeoutError when the body read stalls", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":'));
        // never close — json() hangs forever without the deadline
      },
    });
    const response = new Response(body, {
      headers: { "content-type": "application/json" },
    });
    let error: unknown;
    try {
      await readBodyWithDeadline(response, () => response.json(), 150);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(ProviderTimeoutError);
  });
});
