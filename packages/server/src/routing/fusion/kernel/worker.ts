import { createLogger } from "../../../observability/logger.ts";
import type { FallbackRouter } from "../../fallback.ts";
import type { FusionRequestContext } from "../types.ts";
import {
  parseOpenAIDelta,
  splitSseEvents,
  stripSubagentActionClaims,
  stripToolCallArtifacts,
  type SummarySegment,
} from "../reasoning-summarizer.ts";
import { emitFusion, nowIso } from "../fusion-events.ts";
import type { WorkerRole } from "./types.ts";

const log = createLogger("routing.fusion.kernel.worker");

const MIN_FLUSH_SEGMENT_CHARS = 120;
const MIN_PARAGRAPH_FLUSH_CHARS = 500;

/** Counting semaphore bounding concurrent upstream worker calls. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next !== undefined) next();
  }

  get inFlight(): number {
    return this.active;
  }
}

export interface WorkerRequest {
  id: string;
  role: WorkerRole;
  focus: string;
  routing: string;
  messages: unknown[];
  maxTokens: number;
  /** Hard wall-clock cap. */
  timeoutMs: number;
  /** Abort when no upstream bytes arrive for this long (stalled socket / dead upstream). */
  idleTimeoutMs?: number;
  temperature?: number;
  /** Forwarded to upstream thinking models when set. */
  reasoningEffort?: "low" | "medium" | "high";
  onSegment?: (segment: SummarySegment) => void;
  signal?: AbortSignal;
  semaphore?: Semaphore;
  /** Emit start/progress/completed subagent events for the admin UI. */
  emitEvents?: boolean;
}

export interface WorkerResult {
  content: string;
  success: boolean;
  error?: string;
  durationMs: number;
  finishReason?: string;
  attemptedToolCalls: boolean;
  /** True when the worker was cut off (timeout / quorum cancel) but enough output was kept. */
  truncated?: boolean;
}

/** Partial output at least this long is kept when a worker is cut off. */
const MIN_PARTIAL_CHARS = 800;

/**
 * Run one bounded, streaming worker call. Reasoning/content stream into the
 * live summarizer through `onSegment`; tool-call attempts (workers have no
 * tools) are stripped rather than executed.
 */
export async function runWorker(
  ctx: FusionRequestContext,
  router: FallbackRouter,
  req: WorkerRequest,
): Promise<WorkerResult> {
  const started = performance.now();
  const release = req.semaphore !== undefined ? await req.semaphore.acquire() : () => undefined;
  const emitEvents = req.emitEvents !== false;
  const label = `${req.id} · ${req.focus}`;

  if (emitEvents) {
    emitFusion(ctx, {
      type: "fusion.subagent",
      at: nowIso(),
      id: req.id,
      focus: req.focus,
      model: req.routing,
      status: "started",
      role: req.role,
    });
  }

  const controller = new AbortController();
  let idleAborted = false;
  let lastActivity = performance.now();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  const idleTimer = req.idleTimeoutMs !== undefined && req.idleTimeoutMs > 0
    ? setInterval(() => {
        if (performance.now() - lastActivity > req.idleTimeoutMs!) {
          idleAborted = true;
          controller.abort();
        }
      }, Math.min(5_000, Math.max(500, Math.floor(req.idleTimeoutMs / 4))))
    : undefined;
  const onAbort = () => controller.abort();
  // Both the per-job cancel signal (wave quorum) and the client's abort signal
  // must stop the worker.
  const sources = [req.signal, ctx.signal].filter((s): s is AbortSignal => s !== undefined);
  for (const source of sources) {
    if (source.aborted) controller.abort();
    else source.addEventListener("abort", onAbort, { once: true });
  }

  let content = "";
  let reasoning = "";
  let unsummarized = "";
  let streamedChars = 0;
  let finishReason: string | undefined;
  let attemptedToolCalls = false;

  const emitSegment = (text: string) => {
    const sanitized = stripSubagentActionClaims(stripToolCallArtifacts(text));
    if (sanitized.trim().length === 0) return;
    req.onSegment?.({ label, text: sanitized });
    if (emitEvents) {
      emitFusion(ctx, {
        type: "fusion.subagent",
        at: nowIso(),
        id: req.id,
        focus: req.focus,
        model: req.routing,
        status: "progress",
        role: req.role,
        chars: streamedChars,
      });
    }
  };
  const flush = (force: boolean, segmentChars: number) => {
    if (req.onSegment === undefined || unsummarized.length === 0) return;
    if (force) {
      if (unsummarized.trim().length >= MIN_FLUSH_SEGMENT_CHARS) emitSegment(unsummarized);
      unsummarized = "";
      return;
    }
    if (unsummarized.length >= MIN_PARAGRAPH_FLUSH_CHARS) {
      const boundary = unsummarized.lastIndexOf("\n\n");
      if (boundary >= MIN_FLUSH_SEGMENT_CHARS) {
        emitSegment(unsummarized.slice(0, boundary));
        unsummarized = unsummarized.slice(boundary + 2);
        return;
      }
    }
    if (unsummarized.length >= segmentChars) {
      emitSegment(unsummarized);
      unsummarized = "";
    }
  };

  try {
    const segmentChars = ctx.fusionConfig.summarizer.segment_chars;
    const stream = router.streamWithFallback({
      logicalModel: req.routing,
      requestData: {
        model: req.routing,
        messages: req.messages,
        max_tokens: req.maxTokens,
        stream: true,
        tool_choice: "none",
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.reasoningEffort !== undefined ? { reasoning_effort: req.reasoningEffort } : {}),
      },
      targetProtocol: "openai",
      signal: controller.signal,
      principal: ctx.principal,
      extraHeaders: ctx.extraHeaders,
    });
    for await (const raw of stream) {
      for (const event of splitSseEvents(raw)) {
        const parsed = parseOpenAIDelta(event);
        if (parsed === null) continue;
        // Only real data events count as activity: proxies keep emitting
        // `: keep-alive` comments after the generation behind them has died.
        lastActivity = performance.now();
        if (parsed.hasToolCalls) attemptedToolCalls = true;
        if (parsed.finishReason !== undefined) finishReason = parsed.finishReason;
        if (parsed.content.length > 0) {
          content += parsed.content;
          unsummarized += parsed.content;
          streamedChars += parsed.content.length;
        }
        if (parsed.reasoning.length > 0) {
          if (reasoning.length < 60_000) reasoning += parsed.reasoning;
          unsummarized += parsed.reasoning;
          streamedChars += parsed.reasoning.length;
        }
        flush(false, segmentChars);
      }
    }
    flush(true, segmentChars);

    const cleaned = stripSubagentActionClaims(stripToolCallArtifacts(content)).trim();
    const durationMs = Math.round(performance.now() - started);
    if (cleaned.length === 0) {
      const error = attemptedToolCalls
        ? "worker attempted tool calls and produced no text"
        : "worker produced empty content";
      if (emitEvents) {
        emitFusion(ctx, {
          type: "fusion.subagent",
          at: nowIso(),
          id: req.id,
          focus: req.focus,
          model: req.routing,
          status: "failed",
          role: req.role,
          durationMs,
          error,
        });
      }
      return { content: "", success: false, error, durationMs, finishReason, attemptedToolCalls };
    }
    if (emitEvents) {
      emitFusion(ctx, {
        type: "fusion.subagent",
        at: nowIso(),
        id: req.id,
        focus: req.focus,
        model: req.routing,
        status: "completed",
        role: req.role,
        chars: cleaned.length,
        durationMs,
      });
    }
    log.info("kernel worker completed", { id: req.id, routing: req.routing, chars: cleaned.length, durationMs, finishReason });
    return { content: cleaned, success: true, durationMs, finishReason, attemptedToolCalls };
  } catch (err) {
    const durationMs = Math.round(performance.now() - started);
    const cutOff = controller.signal.aborted && ctx.signal?.aborted !== true;
    const error = cutOff
      ? req.signal?.aborted === true
        ? "worker cancelled (wave quorum reached)"
        : idleAborted
          ? `worker idle for ${req.idleTimeoutMs}ms (stalled upstream)`
          : `worker timed out after ${req.timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    // A cut-off worker that already produced substantial analysis is still
    // evidence: keep it as a truncated result instead of discarding it. A
    // thinking model cut off before its answer leaves only its reasoning
    // trace; the tail of that trace is kept, clearly labelled, so the
    // synthesizer can weigh it rather than losing the work entirely.
    const cleanContent = cutOff ? stripSubagentActionClaims(stripToolCallArtifacts(content)).trim() : "";
    const cleanReasoning = cutOff && cleanContent.length < MIN_PARTIAL_CHARS
      ? stripSubagentActionClaims(stripToolCallArtifacts(reasoning)).trim()
      : "";
    const partial = cleanContent.length >= MIN_PARTIAL_CHARS
      ? cleanContent
      : cleanReasoning.length >= MIN_PARTIAL_CHARS * 2
        ? `[worker was cut off while still reasoning; no final answer was produced. Partial reasoning trace (tail) follows — treat as unverified working notes]\n${cleanReasoning.slice(-8_000)}`
        : "";
    if (partial.length >= MIN_PARTIAL_CHARS) {
      flush(true, ctx.fusionConfig.summarizer.segment_chars);
      log.info("kernel worker cut off; keeping partial output", { id: req.id, routing: req.routing, chars: partial.length, durationMs, reason: error });
      if (emitEvents) {
        emitFusion(ctx, {
          type: "fusion.subagent",
          at: nowIso(),
          id: req.id,
          focus: req.focus,
          model: req.routing,
          status: "completed",
          role: req.role,
          chars: partial.length,
          durationMs,
          detail: { truncated: true, reason: error },
        });
      }
      return { content: partial, success: true, durationMs, finishReason: "length", attemptedToolCalls, truncated: true };
    }
    log.warn("kernel worker failed", { id: req.id, routing: req.routing, error, durationMs });
    if (emitEvents) {
      emitFusion(ctx, {
        type: "fusion.subagent",
        at: nowIso(),
        id: req.id,
        focus: req.focus,
        model: req.routing,
        status: "failed",
        role: req.role,
        durationMs,
        error,
      });
    }
    return { content: "", success: false, error, durationMs, finishReason, attemptedToolCalls };
  } finally {
    clearTimeout(timer);
    if (idleTimer !== undefined) clearInterval(idleTimer);
    for (const source of sources) source.removeEventListener("abort", onAbort);
    release();
  }
}
