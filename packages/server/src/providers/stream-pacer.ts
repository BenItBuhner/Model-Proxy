import { sleep } from "../shared/utils.ts";
import type { ProviderCallContext } from "./base.ts";

/** Minimum buffered chars before paced emission (first piece excepted). */
export const SMOOTH_TARGET_CHARS = 24;
/** Minimum interval between emitted pieces (ms). */
export const SMOOTH_DELAY_MS = 24;
/** Hard cap for a single piece; force-cut here when no whitespace exists. */
export const SMOOTH_MAX_CHARS = 160;



export function isSmoothStreamingGloballyEnabled(): boolean {
  const raw = process.env["MODEL_PROXY_SMOOTH_STREAMING"];
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export function isSmoothStreamingEnabled(ctx: ProviderCallContext): boolean {
  return ctx.smoothStreaming === true || isSmoothStreamingGloballyEnabled();
}

/**
 * Re-chunks content deltas into small word-boundary pieces emitted at a
 * steady cadence, so bursty or fragment-storm upstreams both read as an
 * even stream. The first piece is emitted immediately (no added
 * first-token latency); later pieces wait for SMOOTH_TARGET_CHARS of
 * surplus and are paced at SMOOTH_DELAY_MS, which caps worst-case
 * added latency at one target window while keeping throughput around
 * TARGET/DELAY chars/sec - far above reading speed.
 */
export class StreamPacer {
  private buffer = "";
  private lastEmit = 0;
  private started = false;

  async *feed(text: string): AsyncGenerator<string, void, unknown> {
    this.buffer += text;
    for (;;) {
      if (!this.started) {
        const piece = this.takePiece(1);
        if (piece === undefined) return;
        this.started = true;
        this.lastEmit = Date.now();
        yield piece;
        continue;
      }
      if (this.buffer.length < SMOOTH_TARGET_CHARS) return;
      const elapsed = Date.now() - this.lastEmit;
      if (elapsed < SMOOTH_DELAY_MS) await sleep(SMOOTH_DELAY_MS - elapsed);
      const piece = this.takePiece(SMOOTH_TARGET_CHARS);
      if (piece === undefined) return;
      this.lastEmit = Date.now();
      yield piece;
    }
  }

  /** Emit everything still buffered; called before non-content frames and at stream end. */
  drain(): string {
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  private takePiece(min: number): string | undefined {
    if (this.buffer.length < min) return undefined;
    const limit = Math.min(this.buffer.length, SMOOTH_MAX_CHARS);
    let cut = -1;
    for (let i = min; i < limit; i++) {
      if (/\s/.test(this.buffer[i])) {
        cut = i + 1;
        break;
      }
    }
    if (cut === -1) {
      if (this.buffer.length < SMOOTH_MAX_CHARS) return undefined;
      cut = SMOOTH_MAX_CHARS;
    }
    const piece = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    return piece;
  }
}

/**
 * Content of a single-choice chunk whose delta carries only text (no tool
 * calls, reasoning, or finish state) - the only kind safe to re-chunk.
 * Returns the text to buffer, or undefined when the chunk must pass through.
 */
export function pureContentDelta(chunk: Record<string, unknown>): string | undefined {
  // Chunks carrying usage must pass through untouched: re-chunking would
  // duplicate the usage object onto every emitted piece.
  if (chunk["usage"] !== undefined && chunk["usage"] !== null) return undefined;
  const choices = chunk["choices"];
  if (!Array.isArray(choices) || choices.length !== 1) return undefined;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return undefined;
  const f = first as Record<string, unknown>;
  if (f["finish_reason"] !== null && f["finish_reason"] !== undefined) return undefined;
  if (f["logprobs"] !== undefined && f["logprobs"] !== null) return undefined;
  const delta = f["delta"];
  if (typeof delta !== "object" || delta === null) return undefined;
  const d = delta as Record<string, unknown>;
  if (
    d["tool_calls"] !== undefined ||
    d["function_call"] !== undefined ||
    d["reasoning_content"] !== undefined ||
    d["reasoning"] !== undefined
  ) {
    return undefined;
  }
  const content = d["content"];
  return typeof content === "string" && content.length > 0 ? content : undefined;
}

/** Clone a chunk with choices[0].delta.content replaced by the given piece. */
export function withDeltaContent(
  chunk: Record<string, unknown>,
  piece: string,
): Record<string, unknown> {
  const choices = Array.isArray(chunk["choices"])
    ? (chunk["choices"] as Array<Record<string, unknown>>)
    : [];
  const first = choices[0] ?? {};
  const delta = { ...((first["delta"] as Record<string, unknown>) ?? {}), content: piece };
  return { ...chunk, choices: [{ ...first, delta }, ...choices.slice(1)] };
}
