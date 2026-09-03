import { describe, expect, it } from "bun:test";
import { classifyTurn } from "../src/routing/fusion/kernel/turn-classifier.ts";
import { hashMessages, detectToolError, findLastUserInstruction, isAcknowledgment } from "../src/routing/fusion/kernel/messages.ts";
import { newLedger, beginTask } from "../src/routing/fusion/kernel/session-ledger.ts";
import { deterministicIntent, mergeModelIntent } from "../src/routing/fusion/kernel/intent.ts";
import { compileCapsule } from "../src/routing/fusion/kernel/capsule.ts";
import {
  buildConsensus,
  claimSimilarity,
  extractTrailingJson,
  novelClaimCount,
  parseProposal,
  parseVerdict,
} from "../src/routing/fusion/kernel/waves.ts";
import { decideEscalation, effortBandFor, parseRequestedKernelEffort, widthsFor } from "../src/routing/fusion/kernel/scheduler.ts";
import { ModelPool } from "../src/routing/fusion/kernel/model-pool.ts";
import { computeWorkKey } from "../src/routing/fusion/kernel/work-cache.ts";
import type { KernelLedger, Proposal, Verification } from "../src/routing/fusion/kernel/types.ts";
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
      verification("v3", "p3", "glm", "revise", ["The array is not always empty; counterexample [1]"]),
    ];
    const consensus = buildConsensus(proposals, verifications);
    expect(consensus.familiesAnswered).toBe(3);
    expect(consensus.accepted.some((f) => /42/.test(f.statement))).toBe(true);
    expect(consensus.accepted.find((f) => /42/.test(f.statement))?.support.length).toBe(3);
    expect(consensus.accepted.some((f) => /binary search/i.test(f.statement))).toBe(true);
    expect(consensus.disputed.some((f) => /memoize/i.test(f.statement))).toBe(true);
    expect(consensus.rejected.some((f) => /always empty/i.test(f.statement))).toBe(true);
    expect(consensus.agreement).toBeGreaterThan(0.4);
    expect(consensus.claimConsensus).toBeGreaterThan(0.5);
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
    worker_timeout_seconds: 180,
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
