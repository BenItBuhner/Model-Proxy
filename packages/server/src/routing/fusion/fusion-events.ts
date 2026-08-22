/**
 * Observability bridge for the fusion pipeline.
 *
 * Fusion work spans async generators consumed inside ReadableStream pumps,
 * where AsyncLocalStorage propagation is not guaranteed. The router captures
 * the request's Emitter once (while ALS context is definitely live) and
 * stashes a bound emit function on the FusionRequestContext; every layer of
 * the pipeline then reports through `emitFusion(ctx, ...)`.
 */

import type { RequestEvent } from "../../observability/event-sink.ts";
import { currentEmitter, emit } from "../../observability/request-context.ts";
import type { FusionRequestContext } from "./types.ts";

const MAX_TRACE_SUMMARIES = 40;
const MAX_TRACE_SUMMARY_CHARS = 1000;

/** Capture the current request emitter onto the fusion context (idempotent). */
export function captureFusionEmitter(ctx: FusionRequestContext): void {
  if (ctx.obsEmit !== undefined) return;
  const emitter = currentEmitter();
  if (emitter !== undefined) {
    ctx.obsEmit = (event: RequestEvent) => emitter.emit(event);
  }
}

/** Emit a fusion observability event through the captured emitter (or ALS fallback). */
export function emitFusion(ctx: FusionRequestContext, event: RequestEvent): void {
  try {
    if (event.type === "fusion.summary") {
      const summaries = ctx.fusionSummaries ?? [];
      summaries.push({
        label: event.label.slice(0, 160),
        text: event.text.slice(0, MAX_TRACE_SUMMARY_CHARS),
        at: event.at,
      });
      ctx.fusionSummaries = summaries.slice(-MAX_TRACE_SUMMARIES);
    }
    if (ctx.obsEmit !== undefined) {
      ctx.obsEmit(event);
    } else {
      emit(event);
    }
  } catch {
    // observability must never break the pipeline
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}
