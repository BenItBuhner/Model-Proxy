import type { KernelLedger, ReplanDecision, TurnClassification } from "./types.ts";
import {
  commonPrefixLength,
  detectToolError,
  findLastUserInstruction,
  hasImages,
  hasToolCalls,
  hashMessages,
  instructionHash,
  isAcknowledgment,
  isToolResultMessage,
  messageRole,
  messageText,
} from "./messages.ts";

export interface ClassifyOptions {
  maxStepsBeforeReplan: number;
  repairOnError: boolean;
}

/**
 * Cues that a short user message amends the active task instead of starting
 * a new one. Everything else that is substantive becomes a fresh task.
 */
const CLARIFICATION_LEAD = /^(also|and|but|wait|no[,.!]|not that|instead|actually|make sure|remember|don'?t|do not|note[: ]|one more|additionally|plus|oh|hmm|use|prefer|keep|without|only|just)\b/i;
const CLARIFICATION_MAX_CHARS = 220;

/**
 * Deterministically classify the incoming turn against the durable ledger.
 *
 * - `fresh_task`: a new substantive user instruction (or no ledger yet).
 * - `clarification`: a short amendment to the active task.
 * - `tool_continuation`: only tool calls / tool results / assistant turns
 *   were appended since the ledger's task started — continue the plan.
 * - `trivial_ack`: the user only nudged ("ok", "continue").
 * - `replay`: the exact same message list as the last processed turn.
 */
export function classifyTurn(
  messages: unknown[],
  ledger: KernelLedger | undefined,
  storedHashes: string[],
  options: ClassifyOptions,
): TurnClassification {
  const hashes = hashMessages(messages);
  const commonPrefix = commonPrefixLength(hashes, storedHashes);
  const deltaCount = Math.max(0, messages.length - commonPrefix);
  const lastUser = findLastUserInstruction(messages);
  const lastUserHash = lastUser.index >= 0 ? instructionHash(lastUser.text) : "";
  const intent = ledger?.intent;

  const base = {
    commonPrefix,
    deltaCount,
    lastUserIndex: lastUser.index,
    lastUserText: lastUser.text,
    lastUserHash,
  };

  if (intent === undefined || ledger === undefined) {
    return {
      ...base,
      kind: "fresh_task",
      reason: ledger === undefined ? "no ledger for this conversation" : "ledger has no active intent",
      historyRewritten: false,
      replan: { needed: false, reasons: [] },
    };
  }

  // The client may compact/rewrite history (OpenCode does this on long
  // sessions). If the prefix broke before the task start but the active
  // instruction is still the same goal, treat it as a continuation of that
  // goal rather than a brand new task.
  const historyRewritten = storedHashes.length > 0 && commonPrefix < Math.min(storedHashes.length, ledger.taskStartIndex + 1);
  const sameGoal = lastUser.index >= 0 && lastUserHash === intent.goalHash;

  if (deltaCount === 0 && storedHashes.length === messages.length) {
    return {
      ...base,
      kind: "replay",
      reason: "identical message list replayed",
      historyRewritten: false,
      replan: { needed: false, reasons: [] },
    };
  }

  if (!sameGoal && lastUser.index >= 0) {
    // A different substantive user instruction exists. Is it new since the
    // stored prefix (i.e. actually appended this turn)?
    const appended = lastUser.index >= commonPrefix || historyRewritten;
    if (appended) {
      const text = lastUser.text.trim();
      const isClarification =
        text.length <= CLARIFICATION_MAX_CHARS &&
        CLARIFICATION_LEAD.test(text) &&
        !hasImages(messages[lastUser.index]);
      if (isClarification) {
        return {
          ...base,
          kind: "clarification",
          reason: "short amendment to the active task",
          historyRewritten,
          replan: { needed: true, reasons: ["clarification"] },
        };
      }
      return {
        ...base,
        kind: "fresh_task",
        reason: historyRewritten ? "new instruction after history rewrite" : "new substantive user instruction",
        historyRewritten,
        replan: { needed: false, reasons: [] },
      };
    }
  }

  // From here the active goal is unchanged. Inspect the appended delta.
  const delta = messages.slice(Math.min(commonPrefix, messages.length));
  const replan = evaluateReplan(delta, ledger, options);
  const deltaHasToolTraffic = delta.some((m) => isToolResultMessage(m) || hasToolCalls(m) || messageRole(m) === "assistant");
  const deltaUserAck = delta.some((m) => messageRole(m) === "user" && !isToolResultMessage(m) && isAcknowledgment(messageText(m)));

  if (deltaHasToolTraffic) {
    return {
      ...base,
      kind: "tool_continuation",
      reason: historyRewritten
        ? "same goal after client history rewrite; continuing plan"
        : "only tool calls/results appended since the task started",
      historyRewritten,
      replan,
    };
  }
  if (deltaUserAck) {
    return {
      ...base,
      kind: "trivial_ack",
      reason: "user acknowledgment / continue nudge",
      historyRewritten,
      replan,
    };
  }
  if (historyRewritten && sameGoal) {
    return {
      ...base,
      kind: "tool_continuation",
      reason: "same goal after client history rewrite; continuing plan",
      historyRewritten,
      replan,
    };
  }
  return {
    ...base,
    kind: "tool_continuation",
    reason: "no new user instruction; continuing active task",
    historyRewritten,
    replan,
  };
}

function evaluateReplan(delta: unknown[], ledger: KernelLedger, options: ClassifyOptions): ReplanDecision {
  const reasons: string[] = [];
  let errorSignature: string | undefined;
  let errorExcerpt: string | undefined;

  if (options.repairOnError) {
    // Only the most recent tool results matter: earlier errors in the delta
    // were already visible to the previous continuation step.
    for (let i = delta.length - 1; i >= 0; i--) {
      const message = delta[i];
      if (!isToolResultMessage(message)) {
        if (messageRole(message) === "assistant") break;
        continue;
      }
      const detected = detectToolError(messageText(message));
      if (detected !== undefined) {
        errorSignature = detected.signature;
        errorExcerpt = detected.excerpt;
        reasons.push("tool_error");
        break;
      }
    }
  }
  if (ledger.continuationSteps >= options.maxStepsBeforeReplan) {
    reasons.push("step_budget");
  }
  return { needed: reasons.length > 0, reasons, errorSignature, errorExcerpt };
}
