import { createLogger } from "../../observability/logger.ts";
import { FallbackRouter } from "../fallback.ts";
import type { FusionRequestContext } from "./types.ts";
import type { FusionSummarizerConfig } from "@model-proxy/contracts/schemas/fusion.ts";

const log = createLogger("routing.fusion.summarizer");

// ── OpenAI SSE parsing helpers ────────────────────────────────────────

export interface ParsedOpenAIDelta {
  /** Raw parsed chunk object (mutable — callers may strip fields and re-serialize). */
  chunk: Record<string, unknown>;
  content: string;
  reasoning: string;
  hasToolCalls: boolean;
  /** Raw tool_calls delta array when present. */
  toolCallDeltas: Array<Record<string, unknown>>;
  finishReason: string | undefined;
}

/**
 * Split a raw SSE payload (possibly containing multiple events) into
 * individual event strings, preserving non-data lines untouched.
 */
export function splitSseEvents(raw: string): string[] {
  return raw
    .split(/\n\n/)
    .filter((part) => part.trim().length > 0)
    .map((part) => `${part}\n\n`);
}

/**
 * Parse an OpenAI-format SSE event into its delta fields.
 * Returns null for [DONE] markers, comments, and unparseable events.
 */
export function parseOpenAIDelta(event: string): ParsedOpenAIDelta | null {
  const dataLine = event
    .split("\n")
    .find((line) => line.startsWith("data: ") || line.startsWith("data:"));
  if (dataLine === undefined) return null;
  const payload = dataLine.replace(/^data:\s?/, "").trim();
  if (payload === "" || payload === "[DONE]") return null;
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
  const choices = chunk["choices"] as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const delta = (choice?.["delta"] ?? {}) as Record<string, unknown>;
  const content = typeof delta["content"] === "string" ? delta["content"] : "";
  const reasoningContent = typeof delta["reasoning_content"] === "string" ? delta["reasoning_content"] : "";
  const reasoningField = typeof delta["reasoning"] === "string" ? delta["reasoning"] : "";
  const toolCalls = delta["tool_calls"];
  const toolCallDeltas = Array.isArray(toolCalls) ? (toolCalls as Array<Record<string, unknown>>) : [];
  return {
    chunk,
    content,
    reasoning: reasoningContent || reasoningField,
    hasToolCalls: toolCallDeltas.length > 0,
    toolCallDeltas,
    finishReason: typeof choice?.["finish_reason"] === "string" ? (choice["finish_reason"] as string) : undefined,
  };
}

/**
 * Format a reasoning-channel SSE chunk in the client's protocol.
 * (OpenAI: delta.reasoning_content; Anthropic: thinking_delta.)
 */
export function formatReasoningChunk(ctx: FusionRequestContext, text: string): string {
  if (ctx.clientProtocol === "anthropic") {
    const payload = {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: text },
    };
    return `event: content_block_delta\ndata: ${JSON.stringify(payload)}\n\n`;
  }
  const now = Math.floor(Date.now() / 1000);
  const chunk = {
    id: `chatcmpl-${ctx.requestId ?? now}`,
    object: "chat.completion.chunk",
    created: now,
    model: ctx.logicalModel,
    choices: [
      {
        index: 0,
        delta: { role: "assistant", reasoning_content: text },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

// ── Text hygiene ──────────────────────────────────────────────────────

/**
 * Strip inline tool-call artifacts that models sometimes hallucinate into
 * plain text output (XML-ish tool tags, tool-call JSON blobs, special
 * tool-call tokens). Used on subagent output before it reaches summaries
 * or the synthesis model, so tool-call syntax never masquerades as prose.
 */
export function stripToolCallArtifacts(text: string): string {
  let cleaned = text
    // XML-style tool invocation blocks (various model dialects)
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, " ")
    .replace(/<tool_code>[\s\S]*?(?:<\/tool_code>|$)/gi, " ")
    .replace(/<function_call>[\s\S]*?(?:<\/function_call>|$)/gi, " ")
    .replace(/<invoke[\s\S]*?(?:<\/invoke>|$)/gi, " ")
    // Special tool-call tokens (DeepSeek/GLM/Qwen style)
    .replace(/<\|tool[_▁]?calls?[_▁]?(?:begin|end|start)?\|>/gi, " ")
    .replace(/\[TOOL_CALLS\][\s\S]*?(?:\[\/TOOL_CALLS\]|$)/gi, " ")
    // Fenced code blocks that are clearly tool invocations
    .replace(/```(?:json|tool_code|tool_call)?\s*\{[^`]*"(?:tool_calls|tool_call|function_call)"[\s\S]*?```/gi, " ")
    // Bare JSON blobs shaped like tool invocations: {"name": "...", "arguments": ...}
    .replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"(?:arguments|parameters|input)"\s*:[\s\S]*?\}\s*\}?/g, " ")
    .replace(/\{\s*"(?:tool_calls|tool_call|function_call)"\s*:[\s\S]*?\}\s*\}?/g, " ");

  // Collapse leftover blank runs created by removals (preserve paragraphs)
  cleaned = cleaned.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return cleaned;
}

const SUBAGENT_IMPOSSIBLE_ACTION_CLAIM =
  /\b(?:I|I've|I have|I just|I already|we|we've|we have|we just|we already)\s+(?:successfully\s+|already\s+|just\s+)?(?:applied|changed|committed|created|deleted|deployed|edited|executed|fixed|installed|modified|moved|patched|pushed|ran|removed|renamed|run|updated|wrote)\b/i;

const SUBAGENT_ACTION_CLAIM_REPLACEMENT =
  "[subagent invalid action claim removed: subagents cannot modify files, run commands, commit, push, or deploy]";
const SUBAGENT_ADVISORY_MARKER = /\b(?:Analysis|Finding|Findings|Recommendation|Recommendations|Risk|Risks|Next|Suggested|Suggestion|Evidence|Rationale)\s*:/i;

/**
 * Remove first-person action claims from reasoning-only subagents. Subagents
 * can analyze and recommend, but the primary assistant is the only component
 * allowed to execute tools or mutate the repository.
 */
export function stripSubagentActionClaims(text: string): string {
  let cleaned = text.split(/(\n+)/).map((part) => {
    if (part.startsWith("\n")) return part;
    if (!SUBAGENT_IMPOSSIBLE_ACTION_CLAIM.test(part)) return part;
    const marker = part.match(SUBAGENT_ADVISORY_MARKER);
    const preserved = marker?.index !== undefined && marker.index > 0 ? part.slice(marker.index).trimStart() : "";
    const replacement = part.match(/^\s/)?.[0] ? ` ${SUBAGENT_ACTION_CLAIM_REPLACEMENT}` : SUBAGENT_ACTION_CLAIM_REPLACEMENT;
    return preserved.length > 0 ? `${replacement}\n${preserved}` : replacement;
  }).join("");

  cleaned = cleaned
    .replace(
      new RegExp(
        `${escapeRegExp(SUBAGENT_ACTION_CLAIM_REPLACEMENT)}(?:\\s+${escapeRegExp(SUBAGENT_ACTION_CLAIM_REPLACEMENT)})+`,
        "g",
      ),
      SUBAGENT_ACTION_CLAIM_REPLACEMENT,
    )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

  return cleaned;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Streaming filter that removes <think>/<thinking> spans from text arriving
 * in arbitrary token boundaries. Some summarizer routings (GLM family) leak
 * chain-of-thought tags into their content channel; those must never reach
 * the client's reasoning summaries.
 */
export class ThinkTagFilter {
  private buffer = "";
  private insideThink = false;

  /** Feed a token; returns the cleaned text that is safe to emit now. */
  write(token: string): string {
    this.buffer += token;
    let out = "";

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        const close = this.buffer.match(/<\/think(?:ing)?>/i);
        if (close === null) {
          // Everything so far is inside a think span; keep only a small tail
          // in case the closing tag is split across tokens.
          this.buffer = this.buffer.slice(-12);
          return out;
        }
        this.buffer = this.buffer.slice((close.index ?? 0) + close[0].length);
        this.insideThink = false;
        continue;
      }

      const open = this.buffer.match(/<think(?:ing)?>/i);
      if (open === null) {
        // Emit all but a short tail that could be a partial opening tag.
        const tailStart = this.findPartialTagStart(this.buffer);
        out += this.buffer.slice(0, tailStart);
        this.buffer = this.buffer.slice(tailStart);
        return out;
      }
      out += this.buffer.slice(0, open.index ?? 0);
      this.buffer = this.buffer.slice((open.index ?? 0) + open[0].length);
      this.insideThink = true;
    }
    return out;
  }

  /** Flush any remaining safe text at end of stream. */
  flush(): string {
    if (this.insideThink) {
      this.buffer = "";
      return "";
    }
    const rest = this.buffer;
    this.buffer = "";
    return rest;
  }

  private findPartialTagStart(text: string): number {
    // A '<' within the last 11 chars could start "<thinking>" split across tokens.
    const window = Math.min(11, text.length);
    for (let i = text.length - window; i < text.length; i++) {
      if (text[i] === "<" && /^<\/?t?h?i?n?k?i?n?g?>?$/i.test(text.slice(i))) {
        return i;
      }
    }
    return text.length;
  }
}

// ── Smooth pacing ─────────────────────────────────────────────────────

/** Target characters per emitted reasoning piece. */
const SMOOTH_TARGET_CHARS = 24;

/** Hard ceiling before a piece is cut mid-word. */
const SMOOTH_MAX_CHARS = 56;

/** Delay between emitted pieces (ms) — makes summaries read as a natural stream. */
const SMOOTH_DELAY_MS = 24;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Re-chunks text into small word-boundary pieces emitted with short delays,
 * so summaries stream progressively regardless of how the summarizer model
 * chunked its own output (whole-paragraph blobs become smooth streams).
 */
export class SmoothStreamer {
  private buffer = "";

  async *write(text: string): AsyncGenerator<string, void, unknown> {
    this.buffer += text;
    let emitted = false;
    for (;;) {
      const piece = this.takePiece();
      if (piece === undefined) return;
      if (emitted) await sleep(SMOOTH_DELAY_MS);
      yield piece;
      emitted = true;
    }
  }

  async *drain(): AsyncGenerator<string, void, unknown> {
    for (;;) {
      const piece = this.takePiece();
      if (piece !== undefined) {
        yield piece;
        await sleep(SMOOTH_DELAY_MS);
        continue;
      }
      break;
    }
    if (this.buffer.length > 0) {
      yield this.buffer;
      this.buffer = "";
    }
  }

  private takePiece(): string | undefined {
    if (this.buffer.length < SMOOTH_TARGET_CHARS) return undefined;
    // Cut at the first word boundary at or past the target size.
    let cut = -1;
    const limit = Math.min(this.buffer.length, SMOOTH_MAX_CHARS);
    for (let i = SMOOTH_TARGET_CHARS - 1; i < limit; i++) {
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

// ── Async queue (channel) ─────────────────────────────────────────────

/**
 * Simple unbounded async queue used to bridge push-style producers
 * (subagents streaming in parallel) to the pull-style pipeline generator.
 */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined as never, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.items.length > 0) {
          return Promise.resolve({ value: this.items.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

// ── ReasoningSummarizer ───────────────────────────────────────────────

export interface SummarySegment {
  /** Internal label identifying the producer (observability only — never shown to the client). */
  label: string;
  /** Raw reasoning / transcript text to summarize. */
  text: string;
}

/** Hard wall-clock budget for a single summary segment (stream included). */
const SUMMARIZE_DEADLINE_MS = 30_000;

const SUMMARIZER_SYSTEM_PROMPT = `You are a live reasoning summarizer embedded in a multi-model pipeline. You receive a raw segment of another model's working notes (chain-of-thought, analysis-in-progress, or draft output) and produce a clean, terse narration of what is being done and found.

Hard rules:
- Output 1-2 short sentences of plain prose in present tense. Nothing else.
- Keep concrete specifics: file names, function names, error messages, decisions.
- Complete sentences only. Never trail off, never end with "..." or an unfinished clause.
- Never reproduce raw JSON, code blocks, tool-call syntax, or verbatim transcript fragments.
- No labels, no prefixes (never start with "Summary:", a bracketed tag, or a heading), no markdown, no bullets.
- Never mention "the model", "the agent", "the subagent", "the text", or that you are summarizing. Narrate the ongoing work directly, e.g. "Examining the auth middleware; the token check skips expired sessions."
- If a previous summary is provided, continue the narration naturally without repeating what it already said.`;

/**
 * Live reasoning summarizer.
 *
 * Streams concise summaries of raw reasoning segments through a fast/cheap
 * model routing (default "turbo"). All raw subagent reasoning and the final
 * synthesis model's reasoning flow through here before reaching the client's
 * reasoning channel.
 */
export class ReasoningSummarizer {
  private readonly fallbackRouter: FallbackRouter;

  constructor(fallbackRouter?: FallbackRouter) {
    this.fallbackRouter = fallbackRouter ?? new FallbackRouter();
  }

  configFor(ctx: FusionRequestContext): FusionSummarizerConfig {
    return ctx.fusionConfig.summarizer;
  }

  isEnabled(ctx: FusionRequestContext): boolean {
    return ctx.fusionConfig.summarizer.enabled;
  }

  /**
   * Stream a summary of a raw reasoning segment as plain-text tokens.
   *
   * Robustness measures:
   * - The upstream max_tokens gets generous headroom beyond the visible
   *   summary budget: thinking models (e.g. GLM on the turbo routing) burn
   *   hidden reasoning tokens first and would otherwise return a summary
   *   decapitated mid-sentence by finish_reason=length.
   * - Content is emitted at sentence boundaries; if the stream is truncated
   *   (finish_reason=length), the trailing incomplete sentence is dropped so
   *   the client never sees a summary that cuts off mid-thought.
   * - On summarizer failure, falls back to a locally compacted excerpt so
   *   the pipeline never dies over a summary.
   */
  async *summarize(
    ctx: FusionRequestContext,
    segment: SummarySegment,
    previousSummary?: string,
  ): AsyncGenerator<string, void, unknown> {
    const cfg = this.configFor(ctx);
    const trimmed = stripToolCallArtifacts(segment.text).trim();
    if (trimmed.length === 0) return;

    const userParts: string[] = [];
    if (previousSummary !== undefined && previousSummary.trim().length > 0) {
      userParts.push(`Previous summary (continue from here, do not repeat): ${previousSummary.trim()}`);
    }
    userParts.push(`Raw working notes segment:\n\n${trimmed.slice(0, 24000)}`);

    // Headroom for hidden reasoning tokens on thinking-model routings.
    const upstreamMaxTokens = cfg.max_summary_tokens + 2048;

    // Hard deadline for the whole summarizer call. Upstream sockets can hang
    // mid-body with no data (connection timeouts only cover the header
    // phase); without this, one dead summary stream deadlocks the entire
    // serialized summary pipeline and the client sees a frozen stream.
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      log.warn("summarizer deadline exceeded; aborting summary stream", {
        label: segment.label,
        deadlineMs: SUMMARIZE_DEADLINE_MS,
      });
      deadlineController.abort();
    }, SUMMARIZE_DEADLINE_MS);
    const onClientAbort = () => deadlineController.abort();
    if (ctx.signal !== undefined) {
      if (ctx.signal.aborted) deadlineController.abort();
      else ctx.signal.addEventListener("abort", onClientAbort, { once: true });
    }

    let emitted = false;
    try {
      const streamGen = this.fallbackRouter.streamWithFallback({
        logicalModel: cfg.model_routing,
        requestData: {
          model: cfg.model_routing,
          messages: [
            { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
            { role: "user", content: userParts.join("\n\n") },
          ],
          max_tokens: upstreamMaxTokens,
          temperature: 0.2,
          stream: true,
        },
        targetProtocol: "openai",
        signal: deadlineController.signal,
        principal: ctx.principal,
        extraHeaders: ctx.extraHeaders,
      });

      let pending = "";
      let finishReason: string | undefined;
      for await (const raw of streamGen) {
        for (const event of splitSseEvents(raw)) {
          const parsed = parseOpenAIDelta(event);
          if (parsed === null) continue;
          if (parsed.finishReason !== undefined) {
            finishReason = parsed.finishReason;
          }
          if (parsed.content.length === 0) continue;
          pending += parsed.content;
          // Emit up to the last completed sentence; hold the tail in case
          // the stream gets truncated mid-sentence.
          const boundary = lastSentenceBoundary(pending);
          if (boundary > 0) {
            emitted = true;
            yield pending.slice(0, boundary);
            pending = pending.slice(boundary);
          }
        }
      }
      if (pending.trim().length > 0) {
        if (finishReason === "length") {
          log.debug("summarizer output truncated; dropping incomplete tail", {
            label: segment.label,
            droppedChars: pending.length,
          });
        } else {
          emitted = true;
          yield pending;
        }
      }
      if (!emitted) {
        yield compactFallbackSummary(trimmed);
      }
    } catch (err) {
      log.warn("summarizer call failed; using compact fallback", {
        label: segment.label,
        model: cfg.model_routing,
        error: String(err),
      });
      // Only fall back if nothing streamed yet — never append a raw excerpt
      // after a partial model summary.
      if (!emitted) {
        yield compactFallbackSummary(trimmed);
      }
    } finally {
      clearTimeout(deadlineTimer);
      ctx.signal?.removeEventListener("abort", onClientAbort);
    }
  }
}

/** Index just past the last sentence-ending punctuation, or 0 if none. */
function lastSentenceBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) {
        return i + (next === undefined ? 1 : 2);
      }
    }
    if (ch === "\n") return i + 1;
  }
  return 0;
}

/**
 * Local, model-free fallback: distill the raw text into at most two clean,
 * complete sentences. Never emits raw JSON/code, never truncates mid-thought,
 * and never appends "...".
 */
export function compactFallbackSummary(text: string): string {
  const cleaned = stripToolCallArtifacts(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\{[\s\S]{80,}?\}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "";

  const MAX_CHARS = 280;
  const MAX_SENTENCES = 2;
  const sentences = (cleaned.match(/[^.!?]+[.!?]+(?:\s|$)/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length > 0) {
    let out = "";
    let taken = 0;
    for (const sentence of sentences) {
      const candidate = out.length > 0 ? `${out} ${sentence}` : sentence;
      if (out.length > 0 && candidate.length > MAX_CHARS) break;
      out = candidate;
      taken++;
      if (taken >= MAX_SENTENCES || out.length >= MAX_CHARS) break;
    }
    if (out.length > 0 && out.length <= MAX_CHARS) return out;
    if (out.length > 0) {
      // A single overlong sentence — cut at a word boundary and close it.
      const cut = out.slice(0, MAX_CHARS).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "");
      return cut.length > 0 ? `${cut}.` : "";
    }
  }

  // No sentence boundaries at all — take a word-bounded lead and close it.
  if (cleaned.length <= MAX_CHARS) return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
  const cut = cleaned.slice(0, MAX_CHARS).replace(/\s+\S*$/, "").replace(/[,;:\s]+$/, "");
  return cut.length > 0 ? `${cut}.` : "";
}

// ── Shared summary streaming ──────────────────────────────────────────

/**
 * Summarize one segment and yield cleaned, smoothly paced plain-text pieces.
 * Concatenating the pieces reproduces the full cleaned summary text.
 */
export async function* streamSummaryPieces(
  summarizer: ReasoningSummarizer,
  ctx: FusionRequestContext,
  segment: SummarySegment,
  previousSummary?: string,
): AsyncGenerator<string, void, unknown> {
  const filter = new ThinkTagFilter();
  const smoother = new SmoothStreamer();
  for await (const token of summarizer.summarize(ctx, segment, previousSummary)) {
    const cleaned = filter.write(token);
    if (cleaned.length === 0) continue;
    yield* smoother.write(cleaned);
  }
  const tail = filter.flush();
  if (tail.length > 0) {
    yield* smoother.write(tail);
  }
  yield* smoother.drain();
}

/**
 * Pace an already-final piece of reasoning text (e.g. cache recall notices)
 * into smooth reasoning-channel SSE chunks.
 */
export async function* paceReasoningText(
  ctx: FusionRequestContext,
  text: string,
): AsyncGenerator<string, void, unknown> {
  const smoother = new SmoothStreamer();
  for await (const piece of smoother.write(text)) {
    yield formatReasoningChunk(ctx, piece);
  }
  for await (const piece of smoother.drain()) {
    yield formatReasoningChunk(ctx, piece);
  }
}

// ── SummaryPump ───────────────────────────────────────────────────────

/**
 * Serializes summary segments from parallel producers (subagents) into a
 * single ordered stream of formatted SSE chunks.
 *
 * - Segments never interleave; each summary streams as its own paragraph.
 * - Consecutive queued segments from the same producer are coalesced so
 *   summaries never lag far behind fast subagents.
 * - No labels are emitted to the client — labels only flow to observability
 *   via the onSummary hook.
 * - Output is paced (SmoothStreamer) so paragraphs stream naturally instead
 *   of appearing as instant blobs.
 */
export class SummaryPump {
  private readonly queue = new AsyncEventQueue<string>();
  private readonly waiting: SummarySegment[] = [];
  private readonly lastSummaryByLabel = new Map<string, string>();
  private notify: (() => void) | undefined;
  private closing = false;
  private readonly worker: Promise<void>;

  constructor(
    private readonly summarizer: ReasoningSummarizer,
    private readonly ctx: FusionRequestContext,
    private readonly hooks: {
      /** Fires once per segment with the full summarized text (for observability). */
      onSummary?: (label: string, text: string) => void;
    } = {},
  ) {
    this.worker = this.run();
  }

  enqueue(segment: SummarySegment): void {
    if (this.closing) return;
    this.waiting.push(segment);
    this.notify?.();
  }

  /**
   * Close the output stream once all queued segments finish.
   * Safe to call while the consumer is still iterating chunks().
   */
  finish(): void {
    this.closing = true;
    this.notify?.();
    // Close the queue even if the worker died — otherwise chunks() consumers
    // (and thus the whole client stream) would hang forever.
    void this.worker
      .catch((err) => {
        log.error("summary pump worker crashed", { error: String(err) });
      })
      .finally(() => this.queue.close());
  }

  chunks(): AsyncIterable<string> {
    return this.queue;
  }

  private async run(): Promise<void> {
    for (;;) {
      if (this.waiting.length === 0) {
        if (this.closing) return;
        await new Promise<void>((resolve) => {
          this.notify = resolve;
        });
        this.notify = undefined;
        continue;
      }
      const segment = this.takeCoalesced();
      try {
        await this.emitSegment(segment);
      } catch (err) {
        log.warn("summary pump segment failed", { label: segment.label, error: String(err) });
      }
    }
  }

  /** Merge consecutive queued segments that share a label into one. */
  private takeCoalesced(): SummarySegment {
    const first = this.waiting.shift()!;
    let text = first.text;
    while (this.waiting.length > 0 && this.waiting[0].label === first.label) {
      text += this.waiting.shift()!.text;
    }
    return { label: first.label, text };
  }

  private async emitSegment(segment: SummarySegment): Promise<void> {
    let summaryText = "";
    const previous = this.lastSummaryByLabel.get(segment.label);
    for await (const piece of streamSummaryPieces(this.summarizer, this.ctx, segment, previous)) {
      summaryText += piece;
      this.queue.push(formatReasoningChunk(this.ctx, piece));
    }
    const trimmed = summaryText.trim();
    if (trimmed.length > 0) {
      this.queue.push(formatReasoningChunk(this.ctx, "\n\n"));
      this.lastSummaryByLabel.set(segment.label, trimmed);
      try {
        this.hooks.onSummary?.(segment.label, trimmed);
      } catch {
        // observability hook must never break the pump
      }
    }
  }
}
