import { describe, expect, it } from "bun:test";
import { classifyTurn } from "../src/routing/fusion/kernel/turn-classifier.ts";
import { hashMessages, detectToolError, findLastUserInstruction, isAcknowledgment } from "../src/routing/fusion/kernel/messages.ts";
import { newLedger, beginTask } from "../src/routing/fusion/kernel/session-ledger.ts";
import { deterministicIntent, mergeModelIntent } from "../src/routing/fusion/kernel/intent.ts";
import { compileCapsule } from "../src/routing/fusion/kernel/capsule.ts";
import {
  buildAnswerVote,
  buildConsensus,
  claimSimilarity,
  extractTrailingJson,
  isDecisiveVote,
  normalizeFinalAnswer,
  novelClaimCount,
  parseProposal,
  parseVerdict,
} from "../src/routing/fusion/kernel/waves.ts";
import { decideEscalation, effortBandFor, escalationStrategyNote, parseRequestedKernelEffort, widthsFor } from "../src/routing/fusion/kernel/scheduler.ts";
import { extractIoExamples } from "../src/routing/fusion/kernel/examples.ts";
import { checkCandidateProgram, describeFailures, extractSolveProgram } from "../src/routing/fusion/kernel/execution.ts";
import { ARC_UTILS_SOURCE } from "../src/routing/fusion/kernel/arc-utils-source.ts";
import { readFileSync } from "node:fs";
import { ModelPool } from "../src/routing/fusion/kernel/model-pool.ts";
import { computeWorkKey } from "../src/routing/fusion/kernel/work-cache.ts";
import { assembleStream } from "../src/routing/fusion/kernel/assemble.ts";
import type { KernelLedger, Proposal, Verdict, Verification } from "../src/routing/fusion/kernel/types.ts";
import type { FusionKernelConfig } from "@model-proxy/contracts/schemas/fusion.ts";

const CLASSIFY_OPTS = { maxStepsBeforeReplan: 5, repairOnError: true };

function ledgerWithTask(messages: unknown[], goalText: string, taskStartIndex: number): { ledger: KernelLedger; hashes: string[] } {
  const ledger = beginTask(newLedger("conv-1", "fusion-max"), deterministicIntent(goalText, taskStartIndex), taskStartIndex);
  ledger.lastSearch = { at: "now", effort: "F3", waves: 1, agreement: 0.8, proposals: 3, verifications: 3, workKeys: [], cachedWork: 0, kind: "search" };
  return { ledger, hashes: hashMessages(messages) };
}

const SYSTEM = { role: "system", content: "You are OpenCode, an agentic coding assistant with tools." };
const GOAL = "Refactor the auth middleware to support API keys and add tests across the repo.";

describe("kernel turn classifier", () => {
  it("classifies the first substantive instruction as a fresh task", () => {
    const messages = [SYSTEM, { role: "user", content: GOAL }];
    const c = classifyTurn(messages, undefined, [], CLASSIFY_OPTS);
    expect(c.kind).toBe("fresh_task");
    expect(c.lastUserIndex).toBe(1);
    expect(c.lastUserText).toBe(GOAL);
  });

  it("treats appended tool calls + tool results as a continuation of the same goal", () => {
    const turn1 = [SYSTEM, { role: "user", content: GOAL }];
    const { ledger, hashes } = ledgerWithTask(turn1, GOAL, 1);
    const turn2 = [
      ...turn1,
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"src/auth.ts\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "export function authenticate(req) { return true; }" },
    ];
    const c = classifyTurn(turn2, ledger, hashes, CLASSIFY_OPTS);
    expect(c.kind).toBe("tool_continuation");
    expect(c.commonPrefix).toBe(2);
    expect(c.deltaCount).toBe(2);
    expect(c.replan.needed).toBe(false);
  });

  it("handles Anthropic-shaped tool_use / tool_result blocks as continuation", () => {
    const turn1 = [{ role: "user", content: GOAL }];
    const { ledger, hashes } = ledgerWithTask(turn1, GOAL, 0);
    const turn2 = [
      ...turn1,
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read_file", input: { path: "src/auth.ts" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "export function authenticate() {}" }] },
    ];
    const c = classifyTurn(turn2, ledger, hashes, CLASSIFY_OPTS);
    expect(c.kind).toBe("tool_continuation");
  });

  it("flags a replan with an error signature when the latest tool result failed", () => {
    const turn1 = [SYSTEM, { role: "user", content: GOAL }];
    const { ledger, hashes } = ledgerWithTask(turn1, GOAL, 1);
    const turn2 = [
      ...turn1,
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"bun test\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "error: TypeError: Cannot read properties of undefined (reading 'headers')\n  at authenticate (src/auth.ts:12:5)\nexit code 1" },
    ];
    const c = classifyTurn(turn2, ledger, hashes, CLASSIFY_OPTS);
    expect(c.kind).toBe("tool_continuation");
    expect(c.replan.needed).toBe(true);
    expect(c.replan.reasons).toContain("tool_error");
    expect(typeof c.replan.errorSignature).toBe("string");
    expect(c.replan.errorExcerpt).toContain("TypeError");
  });

  it("does not treat healthy 'error handling' text as a failure", () => {
    expect(detectToolError("Added error handling to the middleware; 0 errors, 12 tests passed.")).toBeUndefined();
    expect(detectToolError("ok\n{\"errors\": []}")).toBeUndefined();
    expect(detectToolError("ENOENT: no such file or directory, open 'src/missing.ts'")).toBeDefined();
  });

  it("classifies a short amendment as a clarification and a new instruction as a fresh task", () => {
    const turn1 = [SYSTEM, { role: "user", content: GOAL }];
    const { ledger, hashes } = ledgerWithTask(turn1, GOAL, 1);
    const clarification = classifyTurn([...turn1, { role: "assistant", content: "Plan..." }, { role: "user", content: "Also make sure the tests cover expired keys." }], ledger, hashes, CLASSIFY_OPTS);
    expect(clarification.kind).toBe("clarification");
    const fresh = classifyTurn([...turn1, { role: "assistant", content: "Done." }, { role: "user", content: "Now write a Python script that scrapes the release notes and summarizes them." }], ledger, hashes, CLASSIFY_OPTS);
    expect(fresh.kind).toBe("fresh_task");
  });

  it("classifies acknowledgments and exact replays", () => {
    const turn1 = [SYSTEM, { role: "user", content: GOAL }];
    const { ledger, hashes } = ledgerWithTask(turn1, GOAL, 1);
    expect(isAcknowledgment("ok continue")).toBe(true);
    expect(isAcknowledgment("Please refactor the parser as well")).toBe(false);
    const ack = classifyTurn([...turn1, { role: "assistant", content: "Shall I proceed?" }, { role: "user", content: "yes go ahead" }], ledger, hashes, CLASSIFY_OPTS);
    expect(ack.kind).toBe("trivial_ack");
    const replay = classifyTurn(turn1, ledger, hashes, CLASSIFY_OPTS);
    expect(replay.kind).toBe("replay");
  });

  it("survives client history compaction when the goal is unchanged", () => {
    const turn1 = [SYSTEM, { role: "user", content: GOAL }, { role: "assistant", content: "Step 1 done." }, { role: "tool", tool_call_id: "x", content: "ok" }];
    const { ledger, hashes } = ledgerWithTask(turn1, GOAL, 1);
    // Client compacted the history: different system prompt, dropped middle messages.
    const rewritten = [
      { role: "system", content: "You are OpenCode. [compacted summary of earlier work]" },
      { role: "user", content: GOAL },
      { role: "assistant", content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "edit", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c9", content: "edited 1 file" },
    ];
    const c = classifyTurn(rewritten, ledger, hashes, CLASSIFY_OPTS);
    expect(c.kind).toBe("tool_continuation");
    expect(c.historyRewritten).toBe(true);
  });

  it("requests a replan once the continuation step budget is exhausted", () => {
    const turn1 = [SYSTEM, { role: "user", content: GOAL }];
    const { ledger, hashes } = ledgerWithTask(turn1, GOAL, 1);
    ledger.continuationSteps = 5;
    const c = classifyTurn([...turn1, { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "ls", arguments: "{}" } }] }, { role: "tool", tool_call_id: "c", content: "src tests" }], ledger, hashes, CLASSIFY_OPTS);
    expect(c.replan.reasons).toContain("step_budget");
  });

  it("finds the last substantive user instruction skipping tool results and acks", () => {
    const messages = [
      { role: "user", content: GOAL },
      { role: "assistant", content: "ok" },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "data" }] },
      { role: "user", content: "thanks" },
    ];
    expect(findLastUserInstruction(messages)).toEqual({ index: 0, text: GOAL });
  });
});

describe("kernel wave parsing and consensus", () => {
  it("parses trailing json blocks leniently (trailing commas, missing braces)", () => {
    const raw = "Reasoning...\n```json\n{\"answer_summary\": \"x\", \"key_claims\": [\"a is 1\", \"b is 2\",], \"confidence\": 0.8\n```";
    const parsed = extractTrailingJson(raw);
    expect(parsed?.["answer_summary"]).toBe("x");
    const proposal = parseProposal(raw);
    expect(proposal.claims).toEqual(["a is 1", "b is 2"]);
    expect(proposal.confidence).toBe(0.8);
    expect(proposal.answer).toBe("Reasoning...");
  });

  it("mines bullet claims when a worker omits the structured block", () => {
    const proposal = parseProposal("Findings:\n- The middleware never checks expiry of the token\n- Tests should cover revoked keys explicitly\n- Use a constant-time compare for the key");
    expect(proposal.claims.length).toBe(3);
    expect(proposal.claims[0]).toContain("never checks expiry");
  });

  it("parses verdicts and infers them from prose when json is missing", () => {
    expect(parseVerdict("```json\n{\"verdict\":\"reject\",\"issues\":[\"off by one\"],\"counterexample\":\"n=0\",\"confidence\":0.9}\n```").verdict).toBe("reject");
    expect(parseVerdict("```json\n{\"verdict\":\"accept\",\"issues\":[],\"counterexample\":null}\n```").counterexample).toBeUndefined();
    expect(parseVerdict("This is incorrect: the counterexample n=0 breaks it.").verdict).toBe("reject");
    expect(parseVerdict("Looks right to me.").verdict).toBe("accept");
  });

  it("scores similar claims as similar and unrelated ones as different", () => {
    expect(claimSimilarity("The auth middleware must check token expiry", "Token expiry must be checked in the auth middleware")).toBeGreaterThan(0.5);
    expect(claimSimilarity("The auth middleware must check token expiry", "Use PostgreSQL for the analytics warehouse")).toBeLessThan(0.2);
  });

  function proposal(id: string, family: string, claims: string[], answer = "answer"): Proposal {
    return { id, family, routing: family, wave: 1, answer, claims, assumptions: [], risks: [], confidence: 0.7, raw: answer, workKey: id, cached: false, durationMs: 1, success: true };
  }
  function verification(id: string, proposalId: string, family: string, verdict: Verification["verdict"], issues: string[] = [], correctClaims: string[] = []): Verification {
    return { id, proposalId, family, routing: family, verdict, issues, correctClaims, confidence: 0.8, raw: "", workKey: id, cached: false, durationMs: 1, success: true };
  }

  it("accepts claims asserted by two families, disputes single-source contradicted claims, rejects refuted ones", () => {
    const proposals = [
      proposal("p1", "glm", ["The answer is 42", "Use binary search over the sorted prefix"]),
      proposal("p2", "kimi", ["The final answer equals 42", "Memoize the recursion"]),
      proposal("p3", "deepseek", ["Answer: 42", "Use binary search on the sorted prefix", "The array is always empty"]),
    ];
    const verifications = [
      verification("v1", "p1", "kimi", "accept", [], ["The answer is 42"]),
      verification("v2", "p2", "deepseek", "revise", ["Memoization is unnecessary here"]),
      verification("v3", "p3", "glm", "reject", ["The array is not always empty; counterexample [1]"]),
    ];
    const consensus = buildConsensus(proposals, verifications);
    expect(consensus.familiesAnswered).toBe(3);
    expect(consensus.accepted.some((f) => /42/.test(f.statement))).toBe(true);
    expect(consensus.accepted.find((f) => /42/.test(f.statement))?.support.length).toBe(3);
    // Multi-family claims survive even when one asserting proposal was rejected.
    expect(consensus.accepted.some((f) => /binary search/i.test(f.statement))).toBe(true);
    // A verifier issue overlapping a single-source claim disputes it ...
    expect(consensus.disputed.some((f) => /memoize/i.test(f.statement))).toBe(true);
    // ... and only an outright reject verdict on a single-source claim rejects it.
    expect(consensus.rejected.some((f) => /always empty/i.test(f.statement))).toBe(true);
    expect(consensus.agreement).toBeGreaterThan(0.4);
    expect(consensus.claimConsensus).toBeGreaterThan(0.5);
  });

  it("parses final answers from the json block or a FINAL:/boxed fallback and normalizes them for voting", () => {
    expect(parseProposal("...\n```json\n{\"answer_summary\":\"s\",\"final_answer\":\"\\\\frac{3}{4}\",\"key_claims\":[\"a\"],\"confidence\":0.9}\n```").finalAnswer).toBe("\\frac{3}{4}");
    expect(parseProposal("Therefore FINAL: 042\n```json\n{\"answer_summary\":\"s\",\"key_claims\":[\"a\"]}\n```").finalAnswer).toBe("042");
    expect(parseProposal("The result is $\\boxed{750}$.").finalAnswer).toBe("750");
    expect(normalizeFinalAnswer("(C)")).toBe("c");
    expect(normalizeFinalAnswer("**042**")).toBe("42");
    expect(normalizeFinalAnswer("$\\frac{3}{4}$")).toBe("3/4");
    expect(normalizeFinalAnswer("Yes.")).toBe("yes");
    expect(normalizeFinalAnswer("1,000")).toBe("1000");
    const verdict = parseVerdict("```json\n{\"verdict\":\"revise\",\"issues\":[\"x\"],\"candidate_final_answer_correct\":false,\"corrected_final_answer\":\"751\",\"confidence\":0.7}\n```");
    expect(verdict.finalAnswerCorrect).toBe(false);
    expect(verdict.correctedFinalAnswer).toBe("751");
  });

  it("tallies a weighted final-answer vote and folds it into agreement", () => {
    const p = (id: string, family: string, finalAnswer: string): Proposal =>
      ({ ...proposal(id, family, [`the answer is ${finalAnswer}`]), finalAnswer });
    const v = (id: string, proposalId: string, family: string, ok: boolean, corrected?: string): Verification =>
      ({ ...verification(id, proposalId, family, ok ? "accept" : "revise"), finalAnswerCorrect: ok, correctedFinalAnswer: corrected });

    const unanimous = buildAnswerVote([p("p1", "glm", "750"), p("p2", "kimi", "750"), p("p3", "deepseek", "$750$")], [v("v1", "p1", "kimi", true)]);
    expect(unanimous?.unanimous).toBe(true);
    expect(unanimous?.leader?.key).toBe("750");
    expect(unanimous?.leader?.weight).toBe(3.5);
    expect(unanimous?.leaderShare).toBe(1);

    // Sloppy declarations with trailing prose merge into the clean answer.
    const sloppy = buildAnswerVote([p("p1", "glm", "1736"), p("p2", "kimi", "1736 as the very last line, and put nothing after"), p("p3", "deepseek", "$1736$")], []);
    expect(sloppy?.unanimous).toBe(true);
    expect(sloppy?.leader?.weight).toBe(3);
    expect(sloppy?.entries).toHaveLength(1);

    const split = buildAnswerVote([p("p1", "glm", "750"), p("p2", "kimi", "500"), p("p3", "deepseek", "750")], [v("v2", "p2", "deepseek", false, "750")]);
    expect(split?.unanimous).toBe(false);
    expect(split?.leader?.key).toBe("750");
    expect(split?.entries.find((e) => e.key === "500")?.weight).toBe(0.5);
    expect(split?.leader?.weight).toBe(2.5);

    const consensus = buildConsensus([p("p1", "glm", "750"), p("p2", "kimi", "750")], []);
    expect(consensus.answerVote?.unanimous).toBe(true);
    expect(consensus.agreement).toBeGreaterThanOrEqual(0.75);

    // Decisive: four reasoners agree (one with a backticked, prose-suffixed declaration),
    // three audits confirm and one rejects — prose claims that never cluster must not force escalation.
    const disjoint = (id: string, family: string, finalAnswer: string, claim: string): Proposal => ({ ...proposal(id, family, [claim]), finalAnswer });
    const decisive = buildConsensus(
      [disjoint("p1", "glm", "699", "N = 5694 via digit analysis"), disjoint("p2", "kimi", "`699` on its own line.", "casework on the thousands digit"), disjoint("p3", "deepseek", "699", "the quotient is 56 and remainder 94"), disjoint("p4", "glm", "$699$", "mod 7 constraints on each digit")],
      [v("v1", "p1", "kimi", true), v("v2", "p3", "glm", true), v("v3", "p4", "kimi", true), { ...verification("v4", "p2", "deepseek", "reject"), finalAnswerCorrect: undefined }],
    );
    expect(decisive.answerVote?.entries).toHaveLength(1);
    expect(decisive.answerVote?.unanimous).toBe(true);
    expect(decisive.agreement).toBeGreaterThanOrEqual(0.8);
    const single = buildConsensus([p("p1", "glm", "750")], []);
    expect(single.agreement).toBeLessThanOrEqual(0.5);
  });

  it("treats a family as one voice: strong majorities and unanimous answers are decisive; verifier-echoed junk is cleaned", () => {
    const p = (id: string, family: string, finalAnswer: string, claim: string): Proposal => ({ ...proposal(id, family, [claim]), finalAnswer });
    const judged = (id: string, proposalId: string, family: string, verdict: Verdict, ok?: boolean): Verification =>
      ({ ...verification(id, proposalId, family, verdict), finalAnswerCorrect: ok });

    // Live failure mmlu-law:932 wave 1: E from glm+kimi (+glm audit confirms), F from deepseek only,
    // and deepseek's own verifier rejects E. Neither the glm confirmation (leader camp) nor the
    // deepseek rejection (dissent camp) is independent, so with three families this is NOT
    // decisive — it escalates to a de-herded wave instead of committing early.
    const majority = buildAnswerVote(
      [p("p1", "glm", "E", "a"), p("p2", "kimi", "E", "b"), p("p3", "deepseek", "F", "c")],
      [judged("v1", "p1", "glm", "revise", true), judged("v2", "p2", "deepseek", "reject", false), judged("v3", "p3", "kimi", "reject", false)],
    );
    expect(majority?.leader?.key).toBe("e");
    expect(isDecisiveVote(majority, [])).toBe(false);
    // With a fourth, uncommitted family confirming the leader, the same split IS decisive.
    const fourFamilies = buildAnswerVote(
      [p("p1", "glm", "E", "a"), p("p2", "kimi", "E", "b"), p("p3", "deepseek", "F", "c")],
      [judged("v1", "p1", "qwen", "accept", true), judged("v2", "p2", "deepseek", "reject", false)],
    );
    expect(isDecisiveVote(fourFamilies, [])).toBe(true);
    // Same split but an INDEPENDENT family (kimi) rejects E → not decisive.
    const contested = buildAnswerVote(
      [p("p1", "glm", "E", "a"), p("p2", "kimi", "E", "b"), p("p3", "deepseek", "F", "c")],
      [judged("v2", "p1", "kimi", "reject", false)],
    );
    expect(isDecisiveVote(contested, [])).toBe(false);
    // Live regression mmlu-law:948: glm+kimi say A, deepseek says F, and only a glm audit
    // confirms A. A confirmation from a family already in the leader camp is not independent.
    const selfConfirmed = buildAnswerVote(
      [p("p1", "glm", "A", "a"), p("p2", "kimi", "A", "b"), p("p3", "deepseek", "F", "c")],
      [judged("v1", "p2", "glm", "accept", true)],
    );
    expect(isDecisiveVote(selfConfirmed, [])).toBe(false);

    // Live failure mmlu-law:919 wave 2: E unanimous across 3 families; verifiers reject on
    // presentation grounds (no final-answer judgment) and one explicitly disputes → decisive.
    const unanimousVerifs = [judged("v1", "p1", "glm", "reject"), judged("v2", "p2", "kimi", "reject"), judged("v3", "p3", "deepseek", "reject"), judged("v4", "p4", "kimi", "reject", false)];
    const unanimous = buildAnswerVote(
      [p("p1", "glm", "E", "a"), p("p2", "kimi", "E", "b"), p("p3", "deepseek", "E", "c"), p("p4", "glm", "E", "d")],
      unanimousVerifs,
    );
    expect(unanimous?.unanimous).toBe(true);
    expect(isDecisiveVote(unanimous, unanimousVerifs)).toBe(true);
    expect(buildConsensus([p("p1", "glm", "E", "a"), p("p2", "kimi", "E", "b"), p("p3", "deepseek", "E", "c")], unanimousVerifs.slice(0, 3)).agreement).toBeGreaterThanOrEqual(0.8);

    // Instruction echoes and placeholders in final_answer declarations.
    const parsedEcho = parseProposal("...\n```json\n{\"answer_summary\":\"s\",\"final_answer\":\"A as the very last line. That way the last line matches the task exactly, and JSON is present.\",\"key_claims\":[\"a\"]}\n```");
    expect(parsedEcho.finalAnswer).toBe("A");
    const parsedTick = parseProposal("...\n```json\n{\"answer_summary\":\"s\",\"final_answer\":\"699` on its own line.\",\"key_claims\":[\"a\"]}\n```");
    expect(parsedTick.finalAnswer).toBe("699");
    const parsedPlaceholder = parseProposal("Reasoning only, no FINAL line.\n```json\n{\"answer_summary\":\"s\",\"final_answer\":\"<letter>` containing only the option letter.\",\"key_claims\":[\"a\"]}\n```");
    expect(parsedPlaceholder.finalAnswer).toBeUndefined();
    const parsedSqrt = parseProposal("...\n```json\n{\"answer_summary\":\"s\",\"final_answer\":\"2\\\\sqrt{106}. Nothing after.\",\"key_claims\":[\"a\"]}\n```");
    expect(parsedSqrt.finalAnswer).toBe("2\\sqrt{106}");

    // Live failure mmlu-law:948 (v11): F 2.5 vs A 2 with identical prose claims — high claim
    // consensus must not let a split, non-decisive vote clear the escalation threshold.
    const splitHighProse = buildConsensus(
      [p("p1", "glm", "F", "the buyer tendered payment and the seller refused"), p("p2", "deepseek", "F", "the buyer tendered payment and the seller refused"), p("p3", "kimi", "A", "the buyer tendered payment and the seller refused"), p("p4", "glm", "A", "the buyer tendered payment and the seller refused")],
      [judged("v1", "p1", "kimi", "accept", true)],
    );
    expect(splitHighProse.answerVote?.leaderShare).toBeLessThan(0.66);
    expect(splitHighProse.agreement).toBeLessThanOrEqual(0.55);

    // Escalation note for a split vote presents camps neutrally and never lists a bare
    // "answer is X" rejection as refuted.
    const split = buildConsensus(
      [p("p1", "glm", "E", "the answer is E"), p("p2", "kimi", "E", "the answer is E"), p("p3", "deepseek", "F", "the answer is F")],
      [{ ...verification("v1", "p1", "deepseek", "reject"), issues: ["the answer is E"], finalAnswerCorrect: false }],
    );
    const note = escalationStrategyNote(split, 2);
    expect(note).toContain("split on the final answer");
    expect(note).toContain("\"E\" (glm, kimi)");
    expect(note).toContain("Re-derive the answer independently");
    expect(note).not.toContain("Claims already refuted");
  });

  it("execution oracle: extracts examples, runs candidate programs, flags memorization, and lets verified programs dominate the vote", async () => {
    const task = "Infer the rule.\n\nTraining pair 1\nInput (2x2):\n[[1,2],\n [3,4]]\nOutput (2x2):\n[[1,3],\n [2,4]]\n\nTraining pair 2\nInput (1x3):\n[[5,6,7]]\nOutput (3x1):\n[[5],[6],[7]]\n\nTest input (2x3):\n[[1,2,3],[4,5,6]]";
    const ex = extractIoExamples(task);
    expect(ex?.examples).toHaveLength(2);
    expect(ex?.tests).toEqual([[[1, 2, 3], [4, 5, 6]]]);
    const raw = extractIoExamples(JSON.stringify({ train: [{ input: [[1]], output: [[2]] }], test: [{ input: [[3]] }] }));
    expect(raw?.examples[0]?.output).toEqual([[2]]);

    const transpose = extractSolveProgram("Rule: transpose.\n```python\ndef solve(grid):\n    return [list(r) for r in zip(*grid)]\n```\n");
    expect(transpose).toBeDefined();
    const ok = await checkCandidateProgram(transpose!, ex!.examples, ex!.tests, 5_000);
    expect(ok.passed).toBe(2);
    expect(ok.testOutputs).toEqual([[[1, 4], [2, 5], [3, 6]]]);
    const wrong = await checkCandidateProgram("def solve(grid):\n    return grid\n", ex!.examples, ex!.tests, 5_000);
    expect(wrong.passed).toBe(0);
    expect(describeFailures(wrong)).toContain("0/2");
    const crash = await checkCandidateProgram("def solve(grid):\n    raise ValueError('boom')\n", ex!.examples, [], 5_000);
    expect(crash.failures[0]?.error).toContain("ValueError");

    // Vote: a verified program outweighs two unverified declarations and is decisive alone.
    const p = (id: string, family: string, finalAnswer: string, execution?: Proposal["execution"]): Proposal => ({ ...proposal(id, family, [`answer ${finalAnswer}`]), finalAnswer, execution });
    const vote = buildAnswerVote(
      [p("p1", "glm", "[[1,4],[2,5],[3,6]]", { passed: 2, total: 2, verified: true, testOutputs: [[[1, 4], [2, 5], [3, 6]]], feedback: "" }), p("p2", "kimi", "[[1,2,3]]"), p("p3", "deepseek", "[[1,2,3]]", { passed: 0, total: 2, verified: false, testOutputs: [], feedback: "0/2" })],
      [],
      { verifiedWeight: 3 },
    );
    expect(vote?.leader?.key).toBe(normalizeFinalAnswer("[[1,4],[2,5],[3,6]]"));
    expect(vote?.leader?.executionVerified).toBe(1);
    expect(vote?.leader?.weight).toBe(3);
    expect(isDecisiveVote(vote, [])).toBe(true);
  });

  it("ships the grid helper library into the solve() sandbox, in sync with arc_utils.py", async () => {
    const py = readFileSync(new URL("../src/routing/fusion/kernel/arc_utils.py", import.meta.url), "utf8");
    expect(ARC_UTILS_SOURCE).toBe(py);
    const r = await checkCandidateProgram("from arc_utils import *\ndef solve(g):\n    comps = connected_components(g, background=0)\n    return extract(g, comps[0])\n", [{ input: [[0, 0, 0], [0, 7, 7], [0, 0, 7]], output: [[7, 7], [0, 7]] }], [[[0, 3], [0, 0]]], 5_000);
    expect(r.passed).toBe(1);
    expect(r.testOutputs).toEqual([[[3]]]);
  });

  it("never rejects a claim on verifier wording overlap when the verdict was not reject", () => {
    const consensus = buildConsensus(
      [proposal("p1", "glm", ["The final count is 750"])],
      [verification("v1", "p1", "kimi", "revise", ["The final count 750 is right but the justification skips the n ≡ 2 (mod 4) case"])],
    );
    expect(consensus.rejected).toHaveLength(0);
    expect(consensus.disputed.some((f) => /750/.test(f.statement))).toBe(true);
  });

  it("caps single-family agreement so one model cannot self-certify", () => {
    const consensus = buildConsensus([proposal("p1", "glm", ["x is 1", "y is 2"])], []);
    expect(consensus.claimConsensus).toBe(0);
    expect(consensus.accepted).toHaveLength(0);
    expect(consensus.disputed).toHaveLength(2);
  });

  it("counts novel claims for livelock detection", () => {
    expect(novelClaimCount(["The answer is 42"], ["Answer: 42", "Use a heap for the top-k selection"])).toBe(1);
    expect(novelClaimCount(["The answer is 42"], ["The answer is 42"])).toBe(0);
  });
});

describe("kernel scheduler", () => {
  const kcfg: FusionKernelConfig = {
    families: [
      { name: "glm", routing: "glm-5.3", alt_routings: ["glm-5.3-alt"], weight: 1, propose: true, verify: true },
      { name: "kimi", routing: "kimi-k3", alt_routings: [], weight: 1, propose: true, verify: true },
      { name: "deepseek", routing: "deepseek-v4-pro-0813", alt_routings: [], weight: 1, propose: true, verify: true },
    ],
    capsule_tokens: 24_000,
    worker_max_tokens: 6_000,
    verifier_max_tokens: 2_500,
    pipeline_verification: true,
    adaptive_verification: true,
    control_proposer: true,
    effort_by_domain: { math: "F3", science: "F3" },
    execution_verification: true,
    execution_timeout_seconds: 10,
    execution_repair_rounds: 2,
    execution_verified_weight: 3,
    execution_settle_grace_seconds: 1,
    compute_scratchpad: false,
    compute_scratchpad_domains: ["math", "science"],
    compute_timeout_seconds: 30,
    compute_rounds: 2,
    synthesis_timeout_seconds: 600,
    worker_reasoning_effort: {},
    worker_timeout_seconds: 300,
    worker_idle_timeout_seconds: 60,
    proposal_width: { F2: 3, F3: 6, max: 9 },
    verifiers_per_candidate: { F2: 1, F3: 2, max: 3 },
    max_waves: { F2: 2, F3: 3, max: 4 },
    agreement_threshold: 0.62,
    max_concurrency: 12,
    wave_quorum: 0.67,
    straggler_grace_seconds: 25,
    search_deadline_seconds: { F2: 240, F3: 480, max: 1500 },
    intent_extraction: true,
    continuation: { enabled: true, max_steps_before_replan: 14, repair_on_error: true, max_repairs_per_signature: 1 },
    policy_version: 1,
  };

  it("maps client effort hints including the fusion extension object and max", () => {
    expect(parseRequestedKernelEffort({})).toBe("auto");
    expect(parseRequestedKernelEffort({ reasoning_effort: "high" })).toBe("high");
    expect(parseRequestedKernelEffort({ fusion: { effort: "max" } })).toBe("max");
    expect(parseRequestedKernelEffort({ fusion_effort: "xhigh" })).toBe("max");
    expect(effortBandFor("F2", "auto")).toBe("F2");
    expect(effortBandFor("F3", "auto")).toBe("F3");
    expect(effortBandFor("F1", "max")).toBe("max");
    expect(effortBandFor("F2", "high")).toBe("F3");
    // Domain-aware floor: only when effort is left to the kernel.
    const byDomain = { math: "F3" as const, science: "F3" as const };
    expect(effortBandFor("F2", "auto", { domains: ["math"], effortByDomain: byDomain })).toBe("F3");
    expect(effortBandFor("F2", "auto", { domains: ["swe", "science"], effortByDomain: byDomain })).toBe("F3");
    expect(effortBandFor("F2", "auto", { domains: ["writing"], effortByDomain: byDomain })).toBe("F2");
    expect(effortBandFor("F2", "low", { domains: ["math"], effortByDomain: byDomain })).toBe("F2");
    expect(effortBandFor("F2", "auto", { domains: ["math"], effortByDomain: { math: "max" } })).toBe("max");
    const mathIntent = deterministicIntent("Find the number of primes p < 100 such that p^2 + 2 is also prime. Compute the answer.", 0);
    expect(mathIntent.domains).toContain("math");
  });

  it("derives widths per band and caps verifiers by available other families", () => {
    expect(widthsFor(kcfg, "F2", 3)).toEqual({ proposals: 3, verifiersPerCandidate: 1, maxWaves: 2 });
    expect(widthsFor(kcfg, "F3", 3)).toEqual({ proposals: 6, verifiersPerCandidate: 2, maxWaves: 3 });
    expect(widthsFor(kcfg, "max", 2)).toEqual({ proposals: 9, verifiersPerCandidate: 1, maxWaves: 4 });
  });

  it("escalates on low agreement, stops at threshold, stops on saturation", () => {
    const widths = widthsFor(kcfg, "F3", 3);
    const base = { agreement: 0.3, claimConsensus: 0.3, verifierAcceptRate: 0.3, accepted: [], disputed: [{ statement: "x", status: "disputed" as const, support: ["glm"], contradictedBy: ["kimi"] }], rejected: [], openIssues: [], familiesAnswered: 3 };
    expect(decideEscalation({ consensus: base, wave: 1, widths, agreementThreshold: 0.62, novelClaimsLastWave: 3, familyCount: 3 }).escalate).toBe(true);
    expect(decideEscalation({ consensus: { ...base, agreement: 0.7 }, wave: 1, widths, agreementThreshold: 0.62, novelClaimsLastWave: 3, familyCount: 3 }).escalate).toBe(false);
    expect(decideEscalation({ consensus: base, wave: 2, widths, agreementThreshold: 0.62, novelClaimsLastWave: 0, familyCount: 3 }).escalate).toBe(false);
    expect(decideEscalation({ consensus: base, wave: 3, widths, agreementThreshold: 0.62, novelClaimsLastWave: 2, familyCount: 3 }).escalate).toBe(false);
  });

  it("rotates proposers across families and never verifies a family with itself when others exist", () => {
    const pool = new ModelPool(kcfg.families);
    const picks = pool.proposers(6);
    expect(new Set(picks.slice(0, 3).map((p) => p.family)).size).toBe(3);
    expect(picks.filter((p) => p.family === "glm").map((p) => p.routing)).toEqual(expect.arrayContaining(["glm-5.3", "glm-5.3-alt"]));
    for (let i = 0; i < 6; i++) {
      for (const v of pool.verifiersFor("glm", 2)) expect(v.family).not.toBe("glm");
    }
    pool.recordOutcome("glm-5.3", false, 100);
    expect(pool.reliability("glm-5.3")).toBeLessThan(1);
    expect(pool.reliability("kimi-k3")).toBe(1);
  });
});

describe("kernel stream assembly", () => {
  async function* chunks(events: unknown[]): AsyncGenerator<string> {
    for (const event of events) {
      yield typeof event === "string" ? event : `data: ${JSON.stringify(event)}\n\n`;
    }
  }
  const openaiChunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>) =>
    ({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage !== undefined ? { usage } : {}) });

  it("assembles OpenAI content, reasoning, split tool-call arguments, finish reason and usage", async () => {
    const assembled = await assembleStream(chunks([
      openaiChunk({ role: "assistant", reasoning_content: "thinking " }),
      openaiChunk({ reasoning_content: "more" }),
      openaiChunk({ content: "Hello " }),
      openaiChunk({ content: "world" }),
      openaiChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"pa" } }] }),
      openaiChunk({ tool_calls: [{ index: 0, function: { arguments: "th\":\"a.ts\"}" } }] }),
      openaiChunk({}, "tool_calls", { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }),
      "data: [DONE]\n\n",
    ]), "openai");
    expect(assembled.content).toBe("Hello world");
    expect(assembled.reasoningContent).toBe("thinking more");
    expect(assembled.toolCalls).toEqual([{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.ts\"}" } }]);
    expect(assembled.finishReason).toBe("tool_calls");
    expect(assembled.usage).toEqual({ promptTokens: 10, completionTokens: 5, totalTokens: 15 });
    expect(assembled.empty).toBe(false);
  });

  it("returns null content for tool-only OpenAI responses and flags empty streams", async () => {
    const toolOnly = await assembleStream(chunks([
      openaiChunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "bash", arguments: "{}" } }] }),
      openaiChunk({}, "tool_calls"),
    ]), "openai");
    expect(toolOnly.content).toBeNull();
    expect(toolOnly.toolCalls).toHaveLength(1);
    const empty = await assembleStream(chunks(["data: [DONE]\n\n"]), "openai");
    expect(empty.empty).toBe(true);
    expect(empty.content).toBe("");
  });

  it("assembles Anthropic text, thinking, tool_use blocks with streamed input json, stop reason and usage", async () => {
    const ev = (type: string, payload: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
    const assembled = await assembleStream(chunks([
      ev("message_start", { message: { usage: { input_tokens: 42, output_tokens: 0 } } }),
      ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }),
      ev("content_block_start", { index: 1, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 1, delta: { type: "text_delta", text: "Reading the file." } }),
      ev("content_block_start", { index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} } }),
      ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{\"path\":" } }),
      ev("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "\"a.ts\"}" } }),
      ev("message_delta", { delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 17 } }),
      ev("message_stop", {}),
    ]), "anthropic");
    expect(assembled.content).toBe("Reading the file.");
    expect(assembled.reasoningContent).toBe("hmm");
    expect(assembled.toolCalls).toEqual([{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }]);
    expect(assembled.finishReason).toBe("tool_calls");
    expect(assembled.usage).toEqual({ promptTokens: 42, completionTokens: 17, totalTokens: 59 });
  });
});

describe("kernel intent + capsule + work keys", () => {
  it("extracts domains and constraints deterministically and merges model intent without losing the goal hash", () => {
    const base = deterministicIntent("Prove that the algorithm terminates; do not use induction on n. Then implement it in TypeScript with tests.", 3);
    expect(base.domains).toEqual(expect.arrayContaining(["math", "swe"]));
    expect(base.constraints.some((c) => /do not use induction/i.test(c))).toBe(true);
    const merged = mergeModelIntent(base, "```json\n{\"goal\":\"Prove termination and ship a tested TS implementation\",\"constraints\":[\"no induction on n\"],\"deliverables\":[\"proof\",\"code\",\"tests\"],\"acceptance\":[\"tests pass\"],\"ambiguities\":[\"which algorithm\"],\"domains\":[\"math\",\"swe\"]}\n```");
    expect(merged.goalHash).toBe(base.goalHash);
    expect(merged.deliverables).toEqual(["proof", "code", "tests"]);
    expect(merged.extractedBy).toBe("model");
    expect(merged.goal).toContain("Kernel restatement");
  });

  it("compiles a bounded capsule with a stable read-set hash and truncates huge tool results", () => {
    const huge = "x".repeat(200_000);
    const messages = [
      { role: "system", content: "You are OpenCode. ".repeat(400) },
      { role: "user", content: GOAL },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"big.log\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: huge },
      { role: "tool", tool_call_id: "c1", content: "second small result about auth middleware expiry" },
    ];
    const intent = deterministicIntent(GOAL, 1);
    const ledger = beginTask(newLedger("c", "fusion-max"), intent, 1);
    const input = { messages, intent, ledger, role: "proposer" as const, objective: "Solve the task", tokenBudget: 8_000, taskStartIndex: 1 };
    const a = compileCapsule(input);
    const b = compileCapsule(input);
    expect(a.readSetHash).toBe(b.readSetHash);
    expect(a.estimatedTokens).toBeLessThan(8_000 * 1.35);
    expect(a.messages).toHaveLength(2);
    expect(a.messages[0]!.role).toBe("system");
    expect(a.messages[1]!.content).toContain("Task ledger");
    expect(a.messages[1]!.content).toContain("auth middleware expiry");
    expect(a.messages[1]!.content).not.toContain("x".repeat(20_000));
    const c = compileCapsule({ ...input, objective: "Verify the candidate" });
    expect(c.readSetHash).not.toBe(a.readSetHash);
    const d = compileCapsule({ ...input, ledger: { ...ledger, findings: [{ id: "f", statement: "new finding", status: "accepted", support: ["glm"], contradictedBy: [], wave: 1 }] } });
    expect(d.readSetHash).not.toBe(a.readSetHash);
  });

  it("gives verifiers the candidate as an attachment and keeps the contract role-specific", () => {
    const messages = [{ role: "user", content: GOAL }];
    const intent = deterministicIntent(GOAL, 0);
    const capsule = compileCapsule({ messages, intent, ledger: undefined, role: "verifier", objective: "Audit", tokenBudget: 6_000, taskStartIndex: 0, attachments: [{ title: "Candidate p1 answer", text: "The answer is 42 because ..." }] });
    expect(capsule.messages[0]!.content).toContain("adversarial verifier");
    expect(capsule.messages[1]!.content).toContain("Candidate p1 answer");
    expect(capsule.messages[1]!.content).toContain("The answer is 42");
  });

  it("derives content-addressed work keys that change with any input dimension", () => {
    const spec = { kind: "proposer" as const, objective: "o", readSetHash: "r", modelRouting: "glm-5.3", strategy: "proposer:wave1", policyVersion: 1, configFingerprint: "cfg" };
    const key = computeWorkKey(spec);
    expect(computeWorkKey({ ...spec })).toBe(key);
    expect(computeWorkKey({ ...spec, readSetHash: "r2" })).not.toBe(key);
    expect(computeWorkKey({ ...spec, modelRouting: "kimi-k3" })).not.toBe(key);
    expect(computeWorkKey({ ...spec, strategy: "proposer:wave2" })).not.toBe(key);
    expect(computeWorkKey({ ...spec, policyVersion: 2 })).not.toBe(key);
  });
});
