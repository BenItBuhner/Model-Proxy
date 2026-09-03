import {
  asReasoningEffort,
  reasoningEffortFromReasoningObject,
  type ReasoningEffort,
} from "@model-proxy/contracts/schemas/reasoning.ts";
import { isObject } from "../shared/utils.ts";

/**
 * Gemini (OpenAI-compat endpoint) thinking support.
 *
 * Google's `/v1beta/openai/` endpoint expresses thinking through
 * `extra_body.google.thinking_config` ({ thinking_level, include_thoughts,
 * ... }) and rejects requests that ALSO carry `reasoning_effort` (400:
 * conflicting reasoning controls). With `include_thoughts: true` it streams
 * thought text back inside `delta.content` — wrapped in `<thought>…</thought>`
 * tags and/or flagged via `delta.extra_content.google.thought === true` — and
 * never uses `reasoning_content`. This module owns both directions of that
 * translation so OpenAI-compatible clients (OpenCode et al.) see canonical
 * `reasoning_content` + `tool_calls` instead of a thought/content mash.
 */

const THOUGHT_OPEN = "<thought>";
const THOUGHT_CLOSE = "</thought>";

function geminiThinkingLevel(effort: ReasoningEffort): string {
  // Gemini's thinking_level vocabulary is "low" | "high" (no medium tier on
  // the OpenAI-compat surface). Bucket medium up: clients that ask for
  // medium reasoning expect substantive thinking, not the minimal tier.
  switch (effort) {
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "high":
      return "high";
  }
}

/**
 * Resolve the `extra_body` to send upstream for a Gemini request.
 *
 * Exactly ONE thinking control is ever emitted:
 * - a client-supplied `extra_body.google.thinking_config` is forwarded
 *   verbatim and wins over any `reasoning_effort` (which is dropped), and
 * - otherwise a recognized `reasoning_effort` / `reasoning.effort` is mapped
 *   to `{ thinking_level, include_thoughts: true }`.
 *
 * Returns `undefined` when there is nothing to forward.
 */
export function buildGeminiExtraBody(args: {
  extra_body?: unknown;
  reasoning?: unknown;
  reasoning_effort?: unknown;
}): Record<string, unknown> | undefined {
  const extraBody = isObject(args.extra_body) ? args.extra_body : undefined;
  const google = isObject(extraBody?.["google"]) ? extraBody["google"] : undefined;
  const clientThinkingConfig = isObject(google?.["thinking_config"])
    ? google["thinking_config"]
    : undefined;
  if (clientThinkingConfig !== undefined) {
    // Explicit client thinking_config: forward as-is. reasoning_effort must
    // NOT be sent alongside it (Google 400s on the conflict); the caller
    // already suppresses it for Gemini.
    return extraBody;
  }

  const effort =
    asReasoningEffort(args.reasoning_effort) ??
    reasoningEffortFromReasoningObject(args.reasoning);
  if (effort === undefined) return extraBody;

  return {
    ...(extraBody ?? {}),
    google: {
      ...(google ?? {}),
      thinking_config: {
        thinking_level: geminiThinkingLevel(effort),
        include_thoughts: true,
      },
    },
  };
}

/** True when a delta/message is flagged as thought via `extra_content.google.thought`. */
export function marksGeminiThought(part: Record<string, unknown>): boolean {
  const extra = part["extra_content"];
  if (!isObject(extra)) return false;
  const google = extra["google"];
  return isObject(google) && google["thought"] === true;
}

export interface GeminiThoughtStreamState {
  /**
   * seekOpen: at a position where a `<thought>` block may start (stream start,
   *   after a closed block, or after flagged thought text).
   * inThought: between `<thought>` and `</thought>`.
   * plain: ordinary content; tags are no longer interpreted (conservative —
   *   avoids mangling legit output that merely mentions the tag).
   */
  mode: "seekOpen" | "inThought" | "plain";
  /** Undecided tail (possible partial tag / leading whitespace) held back. */
  carry: string;
}

export function createGeminiThoughtStreamState(): GeminiThoughtStreamState {
  return { mode: "seekOpen", carry: "" };
}

/** Longest proper prefix of `tag` that `text` ends with (0 when none). */
function partialTagSuffixLength(text: string, tag: string): number {
  const max = Math.min(tag.length - 1, text.length);
  for (let k = max; k > 0; k--) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

/**
 * Route one streamed content fragment into reasoning vs content.
 *
 * `flagged` marks fragments the upstream tagged with
 * `extra_content.google.thought === true`; their text always lands in
 * reasoning (with any literal `<thought>` tags stripped) and they re-arm tag
 * detection so a later unflagged fragment can still open a content section.
 * Partial tags split across fragment boundaries are carried in `state` until
 * they resolve; call `flushGeminiThoughtStream` at end of stream.
 */
export function splitGeminiThoughtStream(
  state: GeminiThoughtStreamState,
  text: string,
  flagged: boolean,
): { reasoning: string; content: string } {
  let reasoning = "";
  let content = "";
  // Flagged thought text can arrive after plain content (interleaved thinking
  // between tool rounds); restart detection so its tags are still stripped.
  if (flagged && state.mode === "plain") state.mode = "seekOpen";
  let buf = state.carry + text;
  state.carry = "";

  while (buf.length > 0) {
    if (state.mode === "inThought") {
      const closeIdx = buf.indexOf(THOUGHT_CLOSE);
      if (closeIdx !== -1) {
        reasoning += buf.slice(0, closeIdx);
        buf = buf.slice(closeIdx + THOUGHT_CLOSE.length);
        state.mode = "seekOpen";
        continue;
      }
      const keep = partialTagSuffixLength(buf, THOUGHT_CLOSE);
      reasoning += buf.slice(0, buf.length - keep);
      state.carry = keep > 0 ? buf.slice(buf.length - keep) : "";
      buf = "";
      continue;
    }

    if (state.mode === "seekOpen") {
      const trimmed = buf.trimStart();
      if (trimmed.length === 0) {
        // Whitespace only — hold until we know whether a tag follows.
        state.carry = buf;
        buf = "";
        continue;
      }
      if (trimmed.startsWith(THOUGHT_OPEN)) {
        state.mode = "inThought";
        buf = trimmed.slice(THOUGHT_OPEN.length);
        continue;
      }
      if (THOUGHT_OPEN.startsWith(trimmed)) {
        // Possible partial `<thought>` split across fragments.
        state.carry = buf;
        buf = "";
        continue;
      }
      if (flagged) {
        // Untagged thought text: everything (incl. leading whitespace) is
        // reasoning, and detection stays armed for the next fragment.
        reasoning += buf;
        buf = "";
        continue;
      }
      state.mode = "plain";
      continue;
    }

    // plain
    if (flagged) reasoning += buf;
    else content += buf;
    buf = "";
  }

  return { reasoning, content };
}

/** Release any held-back tail at end of stream. */
export function flushGeminiThoughtStream(
  state: GeminiThoughtStreamState,
): { reasoning: string; content: string } {
  const carry = state.carry;
  state.carry = "";
  if (carry.length === 0) return { reasoning: "", content: "" };
  if (state.mode === "inThought") {
    // Unterminated thought block: still reasoning, never content.
    return { reasoning: carry, content: "" };
  }
  return { reasoning: "", content: carry };
}

/**
 * Non-streaming variant: peel leading `<thought>…</thought>` blocks off a
 * complete message content string.
 */
export function splitGeminiThoughtBlocks(
  text: string,
): { reasoning: string; content: string } {
  let reasoning = "";
  let rest = text;
  for (;;) {
    const match = /^\s*<thought>([\s\S]*?)<\/thought>/.exec(rest);
    if (match === null) break;
    reasoning += match[1] ?? "";
    rest = rest.slice(match[0].length);
  }
  if (reasoning.length === 0) return { reasoning: "", content: text };
  return { reasoning, content: rest.replace(/^\s+/, "") };
}

/**
 * Normalize a complete (non-streaming) Gemini chat response: thought text is
 * moved out of `message.content` into `message.reasoning_content`.
 * `tool_calls` and `extra_content` (thought signatures) pass through intact.
 */
export function normalizeGeminiChatResponse(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const choices = data["choices"];
  if (!Array.isArray(choices)) return data;
  let changed = false;
  const normalizedChoices = choices.map((choice) => {
    if (!isObject(choice)) return choice;
    const message = choice["message"];
    if (!isObject(message)) return choice;
    const content = message["content"];
    if (typeof content !== "string" || content.length === 0) return choice;
    let finalReasoning: string;
    let finalContent: string;
    if (marksGeminiThought(message)) {
      // The whole message is flagged as thought: everything is reasoning,
      // with any literal tags stripped.
      finalReasoning = content.replaceAll(THOUGHT_OPEN, "").replaceAll(THOUGHT_CLOSE, "");
      finalContent = "";
    } else {
      const split = splitGeminiThoughtBlocks(content);
      finalReasoning = split.reasoning;
      finalContent = split.content;
    }
    if (finalReasoning.length === 0) return choice;
    changed = true;
    const prior =
      typeof message["reasoning_content"] === "string"
        ? message["reasoning_content"]
        : "";
    return {
      ...choice,
      message: {
        ...message,
        content: finalContent,
        reasoning_content: prior + finalReasoning,
      },
    };
  });
  return changed ? { ...data, choices: normalizedChoices } : data;
}
