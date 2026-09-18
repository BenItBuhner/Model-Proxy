import { createLogger } from "../../../observability/logger.ts";
import { extractDraftSolveProgram, extractSolveProgram } from "./execution.ts";
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
  /** Absolute deadline (performance.now() basis); the effective timeout is clipped to it AFTER the semaphore is acquired, so queued workers cannot outlive the search. */
  deadlineAt?: number;
  /**
   * Shared, mutable deadline: the kernel may move `deadlineAt` forward and add
   * `extraMs` to every running worker's cap (in-place search extension) so a
   * still-streaming worker is not killed just because the band clock ran out.
   */
  deadlineRef?: WorkerDeadlineRef;
  /** Abort when no upstream bytes arrive for this long (stalled socket / dead upstream). */
  idleTimeoutMs?: number;
  /** Idle budget that applies until the first data event (upstream queueing); defaults to idleTimeoutMs. */
  firstTokenTimeoutMs?: number;
  temperature?: number;
  /** Forwarded to upstream thinking models when set. */
  reasoningEffort?: "low" | "medium" | "high";
  onSegment?: (segment: SummarySegment) => void;
  signal?: AbortSignal;
  semaphore?: Semaphore;
  /** Process-wide cap for this routing (all runs share it): queue locally instead of tripping the upstream's per-model limit. */
  routingSemaphore?: Semaphore;
  /** Emit start/progress/completed subagent events for the admin UI. */
  emitEvents?: boolean;
}

export interface WorkerDeadlineRef {
  deadlineAt: number;
  extraMs: number;
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
  /** The upstream ended the stream with an error after generation had started; `content` is what arrived. */
  upstreamDied?: boolean;
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
  const releaseRun = req.semaphore !== undefined ? await req.semaphore.acquire() : () => undefined;
  const releaseRouting = req.routingSemaphore !== undefined ? await req.routingSemaphore.acquire() : () => undefined;
  const release = () => { releaseRouting(); releaseRun(); };
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
  // Clip to the absolute deadline now that a slot is held: time spent queued
  // behind the semaphore must not extend the search.
  let effectiveTimeoutMs = req.timeoutMs;
  const deadlineAt = req.deadlineRef?.deadlineAt ?? req.deadlineAt;
  if (deadlineAt !== undefined) {
    const left = deadlineAt - performance.now();
    if (left < 5_000) {
      release();
      if (emitEvents) {
        emitFusion(ctx, { type: "fusion.subagent", at: nowIso(), id: req.id, focus: req.focus, model: req.routing, status: "failed", durationMs: 0, error: "search budget exhausted before start", role: req.role });
      }
      return { content: "", success: false, error: "search budget exhausted before start", durationMs: 0, attemptedToolCalls: false };
    }
    effectiveTimeoutMs = Math.min(req.timeoutMs, left);
  }
  // Re-armed timer: the cap is re-read when it fires, so an in-place extension
  // (deadlineRef moved forward) lets a streaming worker continue.
  const startedAt = performance.now();
  const capAt = (): number => {
    const ref = req.deadlineRef;
    const own = startedAt + req.timeoutMs + (ref?.extraMs ?? 0);
    return ref !== undefined ? Math.min(own, ref.deadlineAt) : startedAt + effectiveTimeoutMs;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const wait = Math.max(0, capAt() - performance.now());
    timer = setTimeout(() => { if (capAt() - performance.now() > 250) arm(); else controller.abort(); }, wait);
  };
  arm();
  // Before the first data event the upstream may simply be queueing the
  // request (NIM-backed routes wait minutes under load), which is not the
  // stalled-mid-generation case the idle timeout exists for; a separate,
  // longer first-token budget applies until something arrives.
  let receivedData = false;
  const idleTimer = req.idleTimeoutMs !== undefined && req.idleTimeoutMs > 0
    ? setInterval(() => {
        const limit = receivedData ? req.idleTimeoutMs! : Math.max(req.idleTimeoutMs!, req.firstTokenTimeoutMs ?? 0);
        if (performance.now() - lastActivity > limit) {
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
    // Consume chunk-by-chunk racing the worker's abort: a stream that ignores
    // the abort signal must not hold the wave hostage. Aborting the controller
    // (hard timeout, idle timeout, cancel, client abort) wakes this loop.
    let wakeAbort: (() => void) | undefined;
    const abortedPromise = new Promise<"aborted">((resolve) => { wakeAbort = () => resolve("aborted"); });
    if (controller.signal.aborted) wakeAbort?.();
    else controller.signal.addEventListener("abort", () => wakeAbort?.(), { once: true });
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([iterator.next(), abortedPromise]);
      if (step === "aborted") {
        void iterator.return?.(undefined).catch(() => undefined);
        throw new DOMException("worker aborted", "AbortError");
      }
      if (step.done) break;
      const raw = step.value;
      for (const event of splitSseEvents(raw)) {
        const parsed = parseOpenAIDelta(event);
        if (parsed === null) continue;
        // Only real data events count as activity: proxies keep emitting
        // `: keep-alive` comments after the generation behind them has died.
        lastActivity = performance.now();
        receivedData = true;
        if (parsed.hasToolCalls) attemptedToolCalls = true;
        if (parsed.finishReason !== undefined) finishReason = parsed.finishReason;
        if (parsed.content.length > 0) {
          content += parsed.content;
          unsummarized += parsed.content;
          streamedChars += parsed.content.length;
        }
        if (parsed.reasoning.length > 0) {
          // Rolling tail: the program a thinking model drafts lives late in
          // a long trace, so the buffer keeps the most recent 90k chars.
          reasoning += parsed.reasoning;
          if (reasoning.length > 120_000) reasoning = reasoning.slice(-90_000);
          unsummarized += parsed.reasoning;
          streamedChars += parsed.reasoning.length;
        }
        flush(false, segmentChars);
      }
    }
    flush(true, segmentChars);

    let cleaned = stripSubagentActionClaims(stripToolCallArtifacts(content)).trim();
    const durationMs = Math.round(performance.now() - started);
    // A thinking model that spends its whole output budget reasoning ends with
    // finish_reason "length" and no content — the same shape as a cut-off
    // stream, and the trace often holds the program it was about to emit.
    if (cleaned.length === 0 && finishReason === "length" && reasoning.length > 0) {
      const draft = extractDraftSolveProgram(reasoning);
      const tail = stripSubagentActionClaims(stripToolCallArtifacts(reasoning)).trim();
      if (draft !== undefined) {
        cleaned = `[worker exhausted its output budget while still reasoning; program drafted in the trace, unverified until executed]\n\`\`\`python\n${draft}\`\`\``;
        log.info("kernel worker hit its output budget; salvaged a drafted solve() program", { id: req.id, routing: req.routing, programChars: draft.length });
      } else if (tail.length >= MIN_PARTIAL_CHARS * 2) {
        cleaned = `[worker exhausted its output budget while still reasoning; no final answer was produced. Partial reasoning trace (tail) follows — treat as unverified working notes]\n${tail.slice(-8_000)}`;
      }
    }
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
    // synthesizer can weigh it rather than losing the work entirely. The same
    // holds when the UPSTREAM ends the stream mid-generation (socket closed,
    // stream error after minutes of output): what arrived is kept.
    const upstreamDied = !cutOff && ctx.signal?.aborted !== true && (content.length > 0 || reasoning.length > 0);
    const salvageable = cutOff || upstreamDied;
    const cleanContent = salvageable ? stripSubagentActionClaims(stripToolCallArtifacts(content)).trim() : "";
    const cleanReasoning = salvageable && cleanContent.length < MIN_PARTIAL_CHARS
      ? stripSubagentActionClaims(stripToolCallArtifacts(reasoning)).trim()
      : "";
    let partial = cleanContent.length >= MIN_PARTIAL_CHARS
      ? cleanContent
      : cleanReasoning.length >= MIN_PARTIAL_CHARS * 2
        ? `[worker was cut off while still reasoning; no final answer was produced. Partial reasoning trace (tail) follows — treat as unverified working notes]\n${cleanReasoning.slice(-8_000)}`
        : "";
    // A program drafted in the cut-off trace is still executable evidence:
    // carry it into the partial output so execution verification gets to judge it.
    const draft = salvageable && extractSolveProgram(cleanContent) === undefined ? extractDraftSolveProgram(reasoning) : undefined;
    if (draft !== undefined) {
      partial = `${partial}\n\n[program drafted in the cut-off reasoning trace; unverified until executed]\n\`\`\`python\n${draft}\`\`\``.trim();
      log.info("kernel worker cut off; salvaged a drafted solve() program", { id: req.id, routing: req.routing, programChars: draft.length });
    }
    if (partial.length >= MIN_PARTIAL_CHARS || draft !== undefined) {
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
      return { content: partial, success: true, durationMs, finishReason: "length", attemptedToolCalls, truncated: true, ...(upstreamDied ? { upstreamDied: true, error } : {}) };
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
    if (timer !== undefined) clearTimeout(timer);
    if (idleTimer !== undefined) clearInterval(idleTimer);
    for (const source of sources) source.removeEventListener("abort", onAbort);
    release();
  }
}

/**
 * A semaphore whose acquisitions are also spaced in time: consecutive starts on
 * one routing are at least `spacingMs` apart, so a cascade of releases (a wave
 * settling, retries firing together) cannot re-create the simultaneous burst
 * that trips the upstream's per-model limit.
 */
export class PacedSemaphore extends Semaphore {
  private lastStartAt = -Infinity;
  private chain: Promise<void> = Promise.resolve();
  constructor(limit: number, private readonly spacingMs: number) { super(limit); }
  override async acquire(): Promise<() => void> {
    const release = await super.acquire();
    if (this.spacingMs <= 0) return release;
    // Serialize the spacing decision so two acquirers cannot both see the same lastStartAt.
    const turn = this.chain.then(async () => {
      const wait = this.lastStartAt + this.spacingMs - performance.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this.lastStartAt = performance.now();
    });
    this.chain = turn.catch(() => undefined);
    await turn;
    return release;
  }
}

/** Process-wide per-routing semaphores (upstream per-model concurrency limits are global to this proxy, not per run). */
const routingSemaphores = new Map<string, Semaphore>();
export function routingSemaphore(routing: string, limit: number, spacingMs = 0): Semaphore {
  const key = `${routing}|${limit}|${spacingMs}`;
  let sem = routingSemaphores.get(key);
  if (sem === undefined) { sem = spacingMs > 0 ? new PacedSemaphore(limit, spacingMs) : new Semaphore(limit); routingSemaphores.set(key, sem); }
  return sem;
}
