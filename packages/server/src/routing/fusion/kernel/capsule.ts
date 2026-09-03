import { estimateTokens, stableHash } from "../../../shared/utils.ts";
import { searchConversationContext } from "../context-search.ts";
import type { KernelIntent, KernelLedger, WorkerRole } from "./types.ts";
import {
  asRecord,
  firstSystemPrompt,
  hashMessage,
  isToolResultMessage,
  messageRole,
  messageText,
  truncateMiddle,
} from "./messages.ts";

/**
 * Context capsule compiler.
 *
 * Every worker receives a purpose-built, bounded context instead of the
 * conversation transcript: a stable contract, the intent/plan snapshot, exact
 * retrieval excerpts for its objective, a bounded recent tail, and the
 * objective. The capsule also yields a read-set hash so identical work against
 * identical readable state is content-addressable.
 */

export interface CapsuleInput {
  messages: unknown[];
  intent: KernelIntent | undefined;
  ledger: KernelLedger | undefined;
  role: WorkerRole;
  objective: string;
  /** Extra material the worker must see verbatim (e.g. a candidate to verify). */
  attachments?: Array<{ title: string; text: string }>;
  tokenBudget: number;
  /** Message index where the active task began; recent tail starts here. */
  taskStartIndex: number;
  /** Optional strategy note (escalation guidance, disputed points). */
  strategyNote?: string;
}

export interface Capsule {
  messages: Array<{ role: "system" | "user"; content: string }>;
  readSetHash: string;
  estimatedTokens: number;
  stats: {
    environmentChars: number;
    briefChars: number;
    excerptChars: number;
    tailMessages: number;
    tailTruncated: boolean;
    attachmentChars: number;
    totalMessages: number;
  };
}

const WORKER_CONTRACT: Record<WorkerRole, string> = {
  intent:
    "You extract structured task intent for an orchestration kernel. Output only the requested JSON.",
  proposer:
    `You are one of several independent expert reasoners inside a multi-model fusion kernel. You cannot see the other reasoners.
You run in a sealed analysis sandbox: no tools, no filesystem, no shell, no network, no ability to act on the user's environment. Tool activity visible in the transcript belongs to a separate harness you are not part of. Never claim to have run, edited, created, or deployed anything.
Your deliverable is the strongest, most specific, evidence-backed answer or plan you can produce for the objective: concrete reasoning, exact values, exact code, exact steps, named risks. Prefer depth on the hard parts over restating the problem. Say clearly when something is uncertain or depends on information you do not have.
Finish with a fenced json block exactly like:
\`\`\`json
{"answer_summary": "<2-4 sentence summary of your answer>", "final_answer": "<the single final answer if the task has one — a number, option letter, yes/no, or short phrase, in the exact format the task requests — otherwise null>", "key_claims": ["<atomic, checkable claim>", "..."], "assumptions": ["..."], "risks": ["..."], "confidence": 0.0}
\`\`\`
key_claims must be 3-10 short, atomic, independently checkable statements (facts, results, decisions, recommended actions). Before writing final_answer, re-check it independently (recompute, substitute back, or re-read the options) — a wrong final answer is the worst possible outcome.`,
  verifier:
    `You are an adversarial verifier inside a multi-model fusion kernel. You did not write the candidate you are auditing and you are from a different model family.
You run in a sealed analysis sandbox with no tools. Do not claim to have executed anything.
Your job is to break the candidate: find concrete errors, counterexamples, unmet requirements, hidden assumptions, missing steps, unsafe actions, or hallucinated facts. Check arithmetic and logic explicitly. Confirm what is right only after trying to falsify it. Be specific and terse; do not rewrite the whole answer.
If the task has a single final answer, independently work it out yourself before judging the candidate's, and say whether the candidate's final answer is correct.
Finish with a fenced json block exactly like:
\`\`\`json
{"verdict": "accept" | "revise" | "reject", "issues": ["<specific issue>", "..."], "counterexample": "<concrete counterexample or null>", "correct_claims": ["<claims you confirmed>"], "candidate_final_answer_correct": true | false | null, "corrected_final_answer": "<your final answer if the candidate's is wrong, else null>", "confidence": 0.0}
\`\`\``,
  repair:
    `You are a diagnostic reasoner inside a multi-model fusion kernel. A tool action taken by the primary agent failed. Diagnose the most likely root cause from the evidence and propose the single best next action (and one fallback) that avoids repeating the failed strategy.
You run in a sealed analysis sandbox with no tools; do not claim to have executed anything.
Finish with a fenced json block exactly like:
\`\`\`json
{"answer_summary": "<diagnosis + recommended next action>", "key_claims": ["<root cause or recommended action>", "..."], "assumptions": ["..."], "risks": ["..."], "confidence": 0.0}
\`\`\``,
  checkpoint:
    `You are a planning reviewer inside a multi-model fusion kernel. The primary agent has executed many steps toward the goal. Review progress against the intent, identify what is done, what remains, what is drifting or at risk, and recommend the precise remaining plan.
You run in a sealed analysis sandbox with no tools; do not claim to have executed anything.
Finish with a fenced json block exactly like:
\`\`\`json
{"answer_summary": "<progress assessment + remaining plan>", "key_claims": ["<remaining step or risk>", "..."], "assumptions": ["..."], "risks": ["..."], "confidence": 0.0}
\`\`\``,
};

export function compileCapsule(input: CapsuleInput): Capsule {
  const budgetChars = Math.max(2_000, input.tokenBudget * 4);
  const contract = WORKER_CONTRACT[input.role];

  // Environment note: the conversation's system prompt defines the harness the
  // primary agent operates in. Workers get a bounded slice so they reason about
  // the right environment without inheriting a 30K token harness prompt.
  const systemPrompt = firstSystemPrompt(input.messages);
  const envBudget = Math.floor(budgetChars * (input.role === "intent" ? 0.08 : 0.12));
  const environment =
    systemPrompt !== undefined && systemPrompt.trim().length > 0
      ? truncateMiddle(systemPrompt.trim(), envBudget, "environment prompt trimmed")
      : "";

  const brief = buildBrief(input);
  const attachments = (input.attachments ?? [])
    .map((a) => `### ${a.title}\n${a.text}`)
    .join("\n\n");
  const attachmentBudget = Math.floor(budgetChars * 0.35);
  const boundedAttachments = attachments.length > 0 ? truncateMiddle(attachments, attachmentBudget, "attachment trimmed") : "";

  // Retrieval excerpts for the objective + goal terms.
  const query = `${input.objective} ${input.intent?.goal ?? ""}`.trim();
  const excerptBudget = Math.floor(budgetChars * (boundedAttachments.length > 0 ? 0.15 : 0.25));
  const excerpts = input.messages.length > 0 && query.length > 0
    ? truncateMiddle(searchConversationContext(input.messages, query), excerptBudget, "excerpts trimmed")
    : "";

  const fixedChars = contract.length + environment.length + brief.length + boundedAttachments.length + excerpts.length + input.objective.length + 600;
  const tailBudget = Math.max(1_200, budgetChars - fixedChars);
  const tail = buildRecentTail(input.messages, input.taskStartIndex, tailBudget);

  const userSections: string[] = [];
  if (environment.length > 0) {
    userSections.push(`## Primary agent environment (excerpt of its system prompt; you are NOT this agent)\n${environment}`);
  }
  userSections.push(brief);
  if (excerpts.length > 0) userSections.push(`## Retrieved conversation excerpts relevant to the objective\n${excerpts}`);
  if (tail.text.length > 0) userSections.push(`## Recent conversation (active task, oldest first${tail.truncated ? ", middle trimmed" : ""})\n${tail.text}`);
  if (boundedAttachments.length > 0) userSections.push(`## Material to evaluate\n${boundedAttachments}`);
  if (input.strategyNote !== undefined && input.strategyNote.trim().length > 0) {
    userSections.push(`## Kernel guidance for this pass\n${input.strategyNote.trim()}`);
  }
  userSections.push(`## Your objective\n${input.objective.trim()}`);

  const messages: Capsule["messages"] = [
    { role: "system", content: contract },
    { role: "user", content: userSections.join("\n\n") },
  ];

  const readSetHash = stableHash({
    role: input.role,
    objective: input.objective,
    goalHash: input.intent?.goalHash,
    brief,
    environment: stableHash(environment),
    excerpts: stableHash(excerpts),
    tail: tail.hashes,
    attachments: stableHash(boundedAttachments),
    strategy: input.strategyNote ?? "",
  }).slice(0, 32);

  return {
    messages,
    readSetHash,
    estimatedTokens: estimateTokens(messages.map((m) => m.content).join("\n")),
    stats: {
      environmentChars: environment.length,
      briefChars: brief.length,
      excerptChars: excerpts.length,
      tailMessages: tail.count,
      tailTruncated: tail.truncated,
      attachmentChars: boundedAttachments.length,
      totalMessages: input.messages.length,
    },
  };
}

function buildBrief(input: CapsuleInput): string {
  const lines: string[] = ["## Task ledger (kernel-maintained, authoritative)"];
  const intent = input.intent;
  if (intent !== undefined) {
    lines.push(`Goal: ${intent.goal}`);
    if (intent.constraints.length > 0) lines.push(`Constraints: ${bullet(intent.constraints)}`);
    if (intent.deliverables.length > 0) lines.push(`Deliverables: ${bullet(intent.deliverables)}`);
    if (intent.acceptance.length > 0) lines.push(`Acceptance: ${bullet(intent.acceptance)}`);
    if (intent.ambiguities.length > 0) lines.push(`Known ambiguities: ${bullet(intent.ambiguities)}`);
    if (intent.domains.length > 0) lines.push(`Domains: ${intent.domains.join(", ")}`);
  } else {
    lines.push("Goal: (not yet extracted — infer from the recent conversation)");
  }
  const ledger = input.ledger;
  if (ledger !== undefined) {
    const accepted = ledger.findings.filter((f) => f.status === "accepted").slice(-12);
    const disputed = ledger.findings.filter((f) => f.status === "disputed").slice(-6);
    if (accepted.length > 0) lines.push(`Accepted findings so far: ${bullet(accepted.map((f) => f.statement))}`);
    if (disputed.length > 0) lines.push(`Disputed points: ${bullet(disputed.map((f) => f.statement))}`);
    if (ledger.plan.length > 0) {
      lines.push(`Plan status: ${bullet(ledger.plan.slice(-12).map((s) => `[${s.status}] ${s.text}`))}`);
    }
    if (ledger.negatives.length > 0) {
      lines.push(`Do not repeat (already failed): ${bullet(ledger.negatives.slice(-6).map((n) => `${n.kind}: ${n.detail}`))}`);
    }
    if (ledger.lastAnswerSummary !== undefined && ledger.lastAnswerSummary.length > 0) {
      lines.push(`Last synthesized answer (summary): ${ledger.lastAnswerSummary}`);
    }
    if (ledger.totalContinuationSteps > 0) {
      lines.push(`Primary agent has executed ${ledger.totalContinuationSteps} tool step(s) on this task.`);
    }
  }
  return lines.join("\n");
}

function bullet(items: string[]): string {
  return `\n${items.map((item) => `  - ${truncateMiddle(item.replace(/\s+/g, " ").trim(), 400, "trimmed")}`).join("\n")}`;
}

interface RecentTail {
  text: string;
  hashes: string[];
  count: number;
  truncated: boolean;
}

/**
 * Render the active-task tail (task start → end) oldest-first. Individual
 * oversized messages are head/tail truncated; when the whole tail exceeds the
 * budget, the middle messages are dropped while the first two and the most
 * recent messages are always kept.
 */
function buildRecentTail(messages: unknown[], taskStartIndex: number, budgetChars: number): RecentTail {
  const start = Math.max(0, Math.min(taskStartIndex, messages.length));
  const slice = messages.slice(start).filter((m) => messageRole(m) !== "system");
  if (slice.length === 0) return { text: "", hashes: [], count: 0, truncated: false };

  const perMessageCap = Math.max(600, Math.floor(budgetChars / Math.min(slice.length, 6)));
  const rendered = slice.map((message) => ({
    hash: hashMessage(message),
    text: renderMessage(message, perMessageCap),
  }));

  let total = rendered.reduce((sum, item) => sum + item.text.length + 2, 0);
  if (total <= budgetChars) {
    return {
      text: rendered.map((r) => r.text).join("\n\n"),
      hashes: rendered.map((r) => r.hash),
      count: rendered.length,
      truncated: false,
    };
  }

  // Keep head (first 2) and as many tail messages as fit.
  const head = rendered.slice(0, Math.min(2, rendered.length));
  const headChars = head.reduce((sum, item) => sum + item.text.length + 2, 0);
  const tail: typeof rendered = [];
  let tailChars = 0;
  for (let i = rendered.length - 1; i >= head.length; i--) {
    const item = rendered[i]!;
    if (headChars + tailChars + item.text.length + 2 > budgetChars) break;
    tail.unshift(item);
    tailChars += item.text.length + 2;
  }
  const kept = [...head, ...tail];
  const omitted = rendered.length - kept.length;
  const parts = kept.map((r) => r.text);
  if (omitted > 0) parts.splice(head.length, 0, `[... ${omitted} intermediate message(s) omitted to fit the capsule budget ...]`);
  total = parts.reduce((sum, p) => sum + p.length + 2, 0);
  let text = parts.join("\n\n");
  if (total > budgetChars) text = truncateMiddle(text, budgetChars, "tail trimmed");
  return {
    text,
    hashes: kept.map((r) => r.hash),
    count: kept.length,
    truncated: true,
  };
}

function renderMessage(message: unknown, maxChars: number): string {
  const role = messageRole(message) || "unknown";
  const obj = asRecord(message);
  let body = messageText(message);
  const toolCalls = obj?.["tool_calls"];
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    const calls = toolCalls.map((tc) => {
      const fn = asRecord(asRecord(tc)?.["function"]);
      const name = typeof fn?.["name"] === "string" ? fn["name"] : "tool";
      const args = typeof fn?.["arguments"] === "string" ? fn["arguments"] : JSON.stringify(fn?.["arguments"] ?? {});
      return `${name}(${truncateMiddle(String(args), 600, "args trimmed")})`;
    });
    body = `${body.length > 0 ? `${body}\n` : ""}[tool calls] ${calls.join("; ")}`;
  }
  const content = obj?.["content"];
  if (Array.isArray(content)) {
    const uses = content
      .map((part) => asRecord(part))
      .filter((p): p is Record<string, unknown> => p !== undefined && p["type"] === "tool_use")
      .map((p) => `${String(p["name"] ?? "tool")}(${truncateMiddle(JSON.stringify(p["input"] ?? {}), 600, "args trimmed")})`);
    if (uses.length > 0) body = `${body.length > 0 ? `${body}\n` : ""}[tool calls] ${uses.join("; ")}`;
  }
  const label = isToolResultMessage(message) ? "tool result" : role;
  const toolName = typeof obj?.["name"] === "string" ? ` ${obj["name"]}` : "";
  return `[${label}${toolName}]\n${truncateMiddle(body, maxChars, "message trimmed")}`;
}
