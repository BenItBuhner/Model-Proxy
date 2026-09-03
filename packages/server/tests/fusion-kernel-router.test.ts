import { rmWithRetry } from "./support.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import type { FusionRequestContext } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "@model-proxy/contracts/schemas/fusion.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { closeOperationalDbForTests, getOperationalDb } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const tmpRoot = path.join(tmpdir(), `mp-fusion-kernel-${process.pid}-${Date.now()}`);
const cacheRoot = path.join(tmpRoot, "xdg");
const originalFetch = globalThis.fetch;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;

process.env.XDG_DATA_HOME = cacheRoot;
process.env.HOME = cacheRoot;

const { FusionRouter } = await import("../src/routing/fusion/fusion-router.ts");

const UPSTREAMS: Record<string, string> = {
  "glm-5.3": "up-glm",
  "glm-5.3-alt": "up-glm-alt",
  "kimi-k3": "up-kimi",
  "deepseek-v4-pro-0813": "up-deepseek",
  "glm-5.3-flash": "up-flash",
  turbo: "up-turbo",
};

const kernelConfig: FusionConfig = {
  enabled: true,
  engine: "kernel",
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.15, effort_2_threshold: 0.45 },
  task_divider: { model_routing: "glm-5.3", timeout_seconds: 30, max_subtasks: 4 },
  effort_levels: {
    1: { model_routing: "glm-5.3-flash" },
    2: { subagent_count: { min: 2, max: 3 }, model_routings: ["glm-5.3"], tools: [] },
    3: { subagent_count: { min: 2, max: 4 }, model_routings: ["glm-5.3"], tools: [] },
  },
  fusion: { model_routing: "glm-5.3", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: true, scope: "permanent" },
  summarizer: { enabled: false, model_routing: "turbo", segment_chars: 300, max_summary_tokens: 128 },
  scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 64, max_wall_ms: 120_000 },
  kernel: {
    families: [
      { name: "glm", routing: "glm-5.3", alt_routings: ["glm-5.3-alt"], weight: 1, propose: true, verify: true },
      { name: "kimi", routing: "kimi-k3", alt_routings: [], weight: 1, propose: true, verify: true },
      { name: "deepseek", routing: "deepseek-v4-pro-0813", alt_routings: [], weight: 1, propose: true, verify: true },
    ],
    synthesis_routing: "glm-5.3",
    fast_routing: "glm-5.3-flash",
    capsule_tokens: 8_000,
    worker_max_tokens: 2_000,
    verifier_max_tokens: 1_500,
    pipeline_verification: true,
    adaptive_verification: false,
    worker_reasoning_effort: { verifier: "low" },
    worker_timeout_seconds: 30,
    worker_idle_timeout_seconds: 20,
    proposal_width: { F2: 3, F3: 3, max: 6 },
    verifiers_per_candidate: { F2: 1, F3: 1, max: 2 },
    max_waves: { F2: 2, F3: 2, max: 3 },
    agreement_threshold: 0.6,
    max_concurrency: 8,
    wave_quorum: 1,
    straggler_grace_seconds: 5,
    search_deadline_seconds: { F2: 60, F3: 60, max: 60 },
    intent_extraction: true,
    continuation: { enabled: true, max_steps_before_replan: 3, repair_on_error: true, max_repairs_per_signature: 1 },
    policy_version: 1,
  },
};

const tools = [
  { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "edit_file", description: "Edit a file", parameters: { type: "object", properties: { path: { type: "string" }, patch: { type: "string" } }, required: ["path", "patch"] } } },
  { type: "function", function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] } } },
];

const SYSTEM = { role: "system", content: "You are OpenCode, an agentic coding assistant. Use the tools to complete the task." };
const GOAL = "Refactor the auth middleware in src/auth.ts to support API keys with expiry, add tests, and make sure bun test passes across the repo.";

interface Captured {
  intent: Array<Record<string, unknown>>;
  proposer: Array<Record<string, unknown>>;
  verifier: Array<Record<string, unknown>>;
  repair: Array<Record<string, unknown>>;
  checkpoint: Array<Record<string, unknown>>;
  synthesis: Array<Record<string, unknown>>;
  summarizer: Array<Record<string, unknown>>;
  models: string[];
}

function emptyCaptured(): Captured {
  return { intent: [], proposer: [], verifier: [], repair: [], checkpoint: [], synthesis: [], summarizer: [], models: [] };
}

function chatResponse(message: Record<string, unknown>, model: unknown, finishReason = "stop"): Response {
  return new Response(JSON.stringify({
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "fake",
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function streamResponse(model: unknown, parts: string[], toolCall?: { name: string; arguments: string }): Response {
  const chunks = parts.map((part) => `data: ${JSON.stringify({ id: "chatcmpl-s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
  if (toolCall !== undefined) {
    chunks.push(`data: ${JSON.stringify({ id: "chatcmpl-s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_s1", type: "function", function: toolCall }] }, finish_reason: null }] })}\n\n`);
  }
  chunks.push(`data: ${JSON.stringify({ id: "chatcmpl-s", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: toolCall !== undefined ? "tool_calls" : "stop" }] })}\n\n`);
  return new Response(`${chunks.join("")}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function systemText(messages: unknown[]): string {
  const system = messages.find((m) => (m as Record<string, unknown>)["role"] === "system") as Record<string, unknown> | undefined;
  return typeof system?.["content"] === "string" ? (system["content"] as string) : "";
}

function allText(messages: unknown[]): string {
  return messages.map((m) => JSON.stringify(m)).join("\n");
}

function familyOf(model: string): string {
  if (model.includes("glm")) return "glm";
  if (model.includes("kimi")) return "kimi";
  return "deepseek";
}

function proposalText(family: string, wave: number, finalAnswer?: string): string {
  const shared = "The middleware must validate API key expiry before authorizing the request";
  const specific: Record<string, string> = {
    glm: "Use a constant-time comparison for API keys",
    kimi: "Add tests covering expired and revoked keys",
    deepseek: "Store key hashes, never raw keys",
  };
  return [
    `Proposal from ${family} (wave ${wave}): implement API key auth with expiry checks.`,
    "```json",
    JSON.stringify({ answer_summary: `${family} plan`, ...(finalAnswer !== undefined ? { final_answer: finalAnswer } : {}), key_claims: [shared, specific[family] ?? "x", "Answer: 42"], assumptions: [], risks: [], confidence: 0.8 }),
    "```",
  ].join("\n");
}

function installFetch(captured: Captured, options: { synthesisToolCall?: boolean; finalAnswers?: Record<string, string> } = {}): void {
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const model = String(body["model"] ?? "");
    const messages = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
    const system = systemText(messages);
    captured.models.push(model);
    const family = familyOf(model);

    if (system.includes("extract structured task intent")) {
      captured.intent.push(body);
      return streamResponse(model, ["```json\n", JSON.stringify({ goal: "Ship API-key auth with expiry + tests", constraints: ["bun test must pass"], deliverables: ["refactored middleware", "tests"], acceptance: ["bun test passes"], ambiguities: [], domains: ["swe"] }), "\n```"]);
    }
    if (system.includes("independent expert reasoners")) {
      captured.proposer.push(body);
      const wave = /wave (\d+)/.exec(allText(messages))?.[1] ?? "1";
      return streamResponse(model, [proposalText(family, Number(wave), options.finalAnswers?.[family])]);
    }
    if (system.includes("adversarial verifier")) {
      captured.verifier.push(body);
      return streamResponse(model, ["Checked the candidate; claims hold.\n```json\n", JSON.stringify({ verdict: "accept", issues: [], counterexample: null, correct_claims: ["The middleware must validate API key expiry before authorizing the request"], confidence: 0.85 }), "\n```"]);
    }
    if (system.includes("diagnostic reasoner")) {
      captured.repair.push(body);
      return streamResponse(model, ["Root cause: the test imports a stale path.\n```json\n", JSON.stringify({ answer_summary: "fix the import path", key_claims: ["The test imports src/auth-old.ts which no longer exists", "Update the import to src/auth.ts and rerun bun test"], assumptions: [], risks: [], confidence: 0.8 }), "\n```"]);
    }
    if (system.includes("planning reviewer")) {
      captured.checkpoint.push(body);
      return streamResponse(model, ["Progress review.\n```json\n", JSON.stringify({ answer_summary: "remaining: run tests", key_claims: ["Run the full test suite and fix failures", "Verify expiry handling end to end"], assumptions: [], risks: [], confidence: 0.7 }), "\n```"]);
    }
    if (system.includes("live reasoning summarizer")) {
      captured.summarizer.push(body);
      return streamResponse(model, ["Examining the middleware and planning the expiry check."]);
    }

    // Synthesis / executor.
    captured.synthesis.push(body);
    const wantsTool = options.synthesisToolCall === true && Array.isArray(body["tools"]);
    if (body["stream"] === true) {
      return wantsTool
        ? streamResponse(model, [], { name: "read_file", arguments: JSON.stringify({ path: "src/auth.ts" }) })
        : streamResponse(model, ["Final synthesized answer: ", "implement API key expiry checks with tests."]);
    }
    if (wantsTool) {
      return chatResponse({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "src/auth.ts" }) } }] }, model, "tool_calls");
    }
    return chatResponse({ role: "assistant", content: `Final synthesized answer (${captured.synthesis.length}): implement API key expiry checks with tests.` }, model);
  }) as unknown as typeof fetch;
}

function makeCtx(messages: unknown[], conversationId: string, extra: Record<string, unknown> = {}): FusionRequestContext {
  return {
    logicalModel: "fusion-max",
    fusionConfig: kernelConfig,
    requestData: { model: "fusion-max", messages, tools, tool_choice: "auto", reasoning_effort: "high", ...extra },
    clientProtocol: "openai",
    messages,
    conversationId,
    requestId: `req-${Math.random().toString(16).slice(2)}`,
  };
}

async function collectStream(gen: AsyncGenerator<string, void, unknown>): Promise<string> {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

describe("Fusion kernel engine", () => {
  let router: InstanceType<typeof FusionRouter>;

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpRoot, "models"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "providers"), { recursive: true });
    for (const [logical, upstream] of Object.entries(UPSTREAMS)) {
      fs.writeFileSync(
        path.join(tmpRoot, "models", `${logical}.json`),
        JSON.stringify({
          logical_name: logical,
          timeout_seconds: 5,
          default_cooldown_seconds: 0,
          model_routings: [{ provider: "openai", model: upstream, api_key_env: ["FAKE_KERNEL_API_KEY"], context_window: 128_000 }],
          fallback_model_routings: [],
        }),
      );
    }
    fs.writeFileSync(
      path.join(tmpRoot, "providers", "openai.json"),
      JSON.stringify({
        name: "openai",
        enabled: true,
        api_keys: { env_var_patterns: ["FAKE_KERNEL_API_KEY"] },
        endpoints: { base_url: "https://fake-kernel.local", completions: "/v1/chat/completions", compatible_format: "openai" },
        authentication: { type: "bearer", header_name: "Authorization", header_format: "Bearer {api_key}" },
        request_config: { timeout_seconds: 5, max_retries: 0, retry_on_status: [] },
      }),
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    closeOperationalDbForTests();
    rmWithRetry(tmpRoot, { recursive: true, force: true });
    delete process.env.FAKE_KERNEL_API_KEY;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  beforeEach(() => {
    // Fresh storage root per test: the work cache is content-addressed
    // globally (identical work in any conversation is reused), so tests that
    // share prompts must not share a database.
    closeOperationalDbForTests();
    setStorageRootForTests(path.join(tmpRoot, `storage-${Date.now()}-${Math.random().toString(16).slice(2)}`));
    router = new FusionRouter();
    process.env.FAKE_KERNEL_API_KEY = "fake-key";
    resetKeyState("openai");
    setPrimaryConfigDirForTests(tmpRoot);
  });

  afterEach(() => {
    setPrimaryConfigDirForTests(undefined);
    closeOperationalDbForTests();
    setStorageRootForTests(undefined);
    globalThis.fetch = originalFetch;
  });

  it("runs cross-family proposal + verification waves for a fresh task, then continues tool turns with a single executor call", async () => {
    const conversationId = `conv-kernel-${Date.now()}`;
    const captured = emptyCaptured();
    installFetch(captured, { synthesisToolCall: true });

    // Turn 1: fresh task (F3 via reasoning_effort=high).
    const turn1 = [SYSTEM, { role: "user", content: GOAL }];
    const first = await router.route(makeCtx(turn1, conversationId));

    expect(captured.intent).toHaveLength(1);
    expect(captured.proposer).toHaveLength(3);
    expect(new Set(captured.proposer.map((b) => familyOf(String(b["model"])))).size).toBe(3);
    expect(captured.verifier).toHaveLength(3);
    // Every verifier audits a candidate from a different family.
    for (const v of captured.verifier) {
      const text = allText(v["messages"] as unknown[]);
      const verifierFamily = familyOf(String(v["model"]));
      expect(text).toContain("Candidate");
      expect(text).not.toContain(`Proposal from ${verifierFamily}`);
    }
    expect(captured.synthesis).toHaveLength(1);
    expect(captured.repair).toHaveLength(0);
    // Workers are sealed: streaming, no tools, tool_choice none, bounded output.
    for (const w of [...captured.proposer, ...captured.verifier]) {
      expect(w["tools"]).toBeUndefined();
      expect(w["tool_choice"]).toBe("none");
      expect(w["stream"]).toBe(true);
      expect(w["max_tokens"]).toBeLessThanOrEqual(2_000);
    }
    // Per-role reasoning effort: verifiers run low, proposers keep the model default.
    for (const v of captured.verifier) expect(v["reasoning_effort"]).toBe("low");
    for (const p of captured.proposer) expect(p["reasoning_effort"]).toBeUndefined();
    // Synthesis received consensus notes and the kernel brief.
    const synthText = allText(captured.synthesis[0]!["messages"] as unknown[]);
    expect(synthText).toContain("KERNEL SYNTHESIS BRIEF");
    expect(synthText).toContain("VERIFIED CONSENSUS");
    expect(synthText).toContain("validate API key expiry");
    expect(first.toolCalls).toHaveLength(1);
    expect(first.cacheHit).toBe(false);
    const trace = first.fusionTrace!;
    expect(trace.kernel?.["mode"]).toBe("search");
    expect(trace.kernel?.["turn"]).toBe("fresh_task");
    expect(trace.kernel?.["waves"]).toBe(1);
    expect(trace.kernel?.["agreement"] as number).toBeGreaterThanOrEqual(0.6);
    expect(trace.kernel?.["workItems"]).toBe(7);
    expect(trace.kernel?.["cachedWorkItems"]).toBe(0);
    expect(trace.steps.map((s) => s.type)).toEqual(expect.arrayContaining(["turn_classification", "intent", "proposal", "verification", "escalation", "synthesis"]));

    const db = getOperationalDb();
    const session = db.query("SELECT ledger_json FROM fusion_kernel_sessions WHERE conversation_id = ?").get(conversationId) as { ledger_json: string } | undefined;
    expect(session).toBeDefined();
    const ledger = JSON.parse(session!.ledger_json) as Record<string, unknown>;
    expect((ledger["findings"] as unknown[]).length).toBeGreaterThan(0);
    expect((ledger["intent"] as Record<string, unknown>)["extractedBy"]).toBe("model");
    const workRows = db.query("SELECT COUNT(*) AS count FROM fusion_kernel_work").get() as { count: number };
    expect(workRows.count).toBe(7);

    // Turn 2: the agent executed the tool call; a tool result arrives. Must NOT re-plan.
    const turn2 = [
      ...turn1,
      { role: "assistant", content: null, tool_calls: first.toolCalls },
      { role: "tool", tool_call_id: "call_1", content: "export function authenticate(req) {\n  const key = req.headers['x-api-key'];\n  return key !== undefined;\n}\n" },
    ];
    const before = { proposer: captured.proposer.length, verifier: captured.verifier.length, synthesis: captured.synthesis.length, intent: captured.intent.length };
    const second = await router.route(makeCtx(turn2, conversationId));
    expect(captured.proposer.length).toBe(before.proposer);
    expect(captured.verifier.length).toBe(before.verifier);
    expect(captured.intent.length).toBe(before.intent);
    expect(captured.synthesis.length).toBe(before.synthesis + 1);
    expect(second.fusionTrace?.kernel?.["mode"]).toBe("continue");
    expect(second.fusionTrace?.kernel?.["turn"]).toBe("tool_continuation");
    expect(second.fusionTrace?.kernel?.["totalContinuationSteps"]).toBe(1);
    const contText = allText(captured.synthesis[1]!["messages"] as unknown[]);
    expect(contText).toContain("KERNEL CONTINUATION BRIEF");
    expect(contText).toContain("do NOT restart planning");
    expect(contText).toContain("validate API key expiry");
    // The executor still sees the real tool result.
    expect(contText).toContain("x-api-key");

    // Turn 3: exact replay of turn 1 → every work item is served from the cache, synthesis re-runs.
    const before3 = { proposer: captured.proposer.length, verifier: captured.verifier.length, synthesis: captured.synthesis.length };
    const third = await router.route(makeCtx(turn1, conversationId));
    expect(captured.proposer.length).toBe(before3.proposer);
    expect(captured.verifier.length).toBe(before3.verifier);
    expect(captured.synthesis.length).toBe(before3.synthesis + 1);
    expect(third.fusionTrace?.kernel?.["turn"]).toBe("replay");
    expect(third.fusionTrace?.kernel?.["mode"]).toBe("search");
    expect(third.fusionTrace?.kernel?.["cachedWorkItems"]).toBe(third.fusionTrace?.kernel?.["workItems"]);
    expect(third.cacheHit).toBe(true);
  });

  it("runs a bounded cross-family repair wave on a failed tool step and refuses to repeat it for the same failure", async () => {
    const conversationId = `conv-repair-${Date.now()}`;
    const captured = emptyCaptured();
    installFetch(captured, { synthesisToolCall: true });
    const turn1 = [SYSTEM, { role: "user", content: GOAL }];
    const first = await router.route(makeCtx(turn1, conversationId));
    expect(captured.proposer).toHaveLength(3);

    const failing = [
      ...turn1,
      { role: "assistant", content: null, tool_calls: first.toolCalls },
      { role: "tool", tool_call_id: "call_1", content: "error: Cannot find module './auth-old' imported from tests/auth.test.ts\nexit code 1" },
    ];
    const before = { proposer: captured.proposer.length, synthesis: captured.synthesis.length };
    const repaired = await router.route(makeCtx(failing, conversationId));
    expect(captured.repair).toHaveLength(3);
    expect(captured.proposer.length).toBe(before.proposer);
    expect(captured.synthesis.length).toBe(before.synthesis + 1);
    expect(repaired.fusionTrace?.kernel?.["mode"]).toBe("continue");
    const repair = repaired.fusionTrace?.kernel?.["repair"] as Record<string, unknown>;
    expect(repair["attempts"]).toBe(1);
    expect(repair["exhausted"]).toBe(false);
    const execText = allText(captured.synthesis[captured.synthesis.length - 1]!["messages"] as unknown[]);
    expect(execText).toContain("REPAIR");
    expect(execText).toContain("auth-old");
    expect(repaired.fusionTrace?.steps.some((s) => s.type === "repair")).toBe(true);

    // Same failure signature again → no second repair wave; brief forces a strategy change.
    const failingAgain = [
      ...failing,
      { role: "assistant", content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "bash", arguments: "{\"cmd\":\"bun test\"}" } }] },
      { role: "tool", tool_call_id: "call_2", content: "error: Cannot find module './auth-old' imported from tests/auth2.test.ts\nexit code 1" },
    ];
    const beforeRepairs = captured.repair.length;
    const exhausted = await router.route(makeCtx(failingAgain, conversationId));
    expect(captured.repair.length).toBe(beforeRepairs);
    const repair2 = exhausted.fusionTrace?.kernel?.["repair"] as Record<string, unknown>;
    expect(repair2["exhausted"]).toBe(true);
    const execText2 = allText(captured.synthesis[captured.synthesis.length - 1]!["messages"] as unknown[]);
    expect(execText2).toContain("Do not retry the same action");
    // One row per failure signature: two different test files with the same
    // missing-module error collapse to a single signature that escalated from
    // tool_error (1 repair) to repair_exhausted (2nd occurrence).
    const negatives = getOperationalDb().query("SELECT kind, attempts FROM fusion_kernel_negatives WHERE conversation_id = ? ORDER BY kind").all(conversationId) as Array<{ kind: string; attempts: number }>;
    expect(negatives).toHaveLength(1);
    expect(negatives[0]).toEqual({ kind: "repair_exhausted", attempts: 2 });
  });

  it("runs a checkpoint wave once the continuation step budget is exhausted", async () => {
    const conversationId = `conv-ckpt-${Date.now()}`;
    const captured = emptyCaptured();
    installFetch(captured, { synthesisToolCall: true });
    let messages: unknown[] = [SYSTEM, { role: "user", content: GOAL }];
    const first = await router.route(makeCtx(messages, conversationId));
    for (let step = 1; step <= 4; step++) {
      messages = [
        ...messages,
        { role: "assistant", content: null, tool_calls: step === 1 ? first.toolCalls : [{ id: `call_${step}`, type: "function", function: { name: "read_file", arguments: `{"path":"src/file${step}.ts"}` } }] },
        { role: "tool", tool_call_id: step === 1 ? "call_1" : `call_${step}`, content: `export const value${step} = ${step};` },
      ];
      const result = await router.route(makeCtx(messages, conversationId));
      expect(result.fusionTrace?.kernel?.["mode"]).toBe("continue");
      if (step < 4) expect(result.fusionTrace?.kernel?.["checkpoint"]).toBe(false);
      else expect(result.fusionTrace?.kernel?.["checkpoint"]).toBe(true);
    }
    expect(captured.checkpoint).toHaveLength(3);
    expect(captured.proposer).toHaveLength(3);
    const session = getOperationalDb().query("SELECT ledger_json FROM fusion_kernel_sessions WHERE conversation_id = ?").get(conversationId) as { ledger_json: string };
    const ledger = JSON.parse(session.ledger_json) as { continuationSteps: number; plan: unknown[] };
    expect(ledger.continuationSteps).toBe(1);
    expect(ledger.plan.length).toBeGreaterThan(0);
  });

  it("streams kernel narration, worker summaries, and the synthesized answer", async () => {
    const conversationId = `conv-stream-${Date.now()}`;
    const captured = emptyCaptured();
    installFetch(captured);
    const ctx = makeCtx([SYSTEM, { role: "user", content: GOAL }], conversationId, { stream: true });
    ctx.fusionConfig = { ...kernelConfig, summarizer: { ...kernelConfig.summarizer, enabled: true } };
    const out = await collectStream(router.stream(ctx));
    expect(out).toContain("reasoning_content");
    expect(out).toContain("Kernel: new task");
    expect(out).toContain("cross-family");
    expect(out).toContain("Final synthesized answer");
    expect(captured.proposer).toHaveLength(3);
    expect(captured.verifier).toHaveLength(3);
    expect(captured.synthesis).toHaveLength(1);
    expect(captured.summarizer.length).toBeGreaterThan(0);
    // Trailing SSE comment carries the kernel summary for harnesses/observability.
    const traceComment = out.split("\n").find((line) => line.startsWith(": fusion-kernel "));
    expect(traceComment).toBeDefined();
    const traceJson = JSON.parse(traceComment!.slice(": fusion-kernel ".length)) as Record<string, unknown>;
    expect(traceJson["mode"]).toBe("search");
    expect(traceJson["engine"]).toBe("kernel");
    expect(ctx.streamFusionTrace?.["kernel"]).toBeDefined();
    expect((ctx.streamFusionTrace?.["kernel"] as Record<string, unknown>)["mode"]).toBe("search");
    const session = getOperationalDb().query("SELECT ledger_json FROM fusion_kernel_sessions WHERE conversation_id = ?").get(conversationId) as { ledger_json: string };
    const ledger = JSON.parse(session.ledger_json) as { lastAnswerSummary?: string };
    expect(ledger.lastAnswerSummary).toContain("Final synthesized answer");
  });

  it("settles a wave on quorum, cancels the straggler after grace, and keeps its partial output as truncated evidence", async () => {
    const conversationId = `conv-quorum-${Date.now()}`;
    const captured = emptyCaptured();
    installFetch(captured);
    const baseFetch = globalThis.fetch;
    let hangingAborted = false;
    // The deepseek proposer streams a substantial partial proposal, then hangs until aborted.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const system = systemText(Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : []);
      if (String(body["model"]) === "up-deepseek" && system.includes("independent expert reasoners")) {
        captured.proposer.push(body);
        const partial = `Deepseek partial proposal: ${"the middleware must validate API key expiry before authorizing the request. ".repeat(14)}`;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 1, model: body["model"], choices: [{ index: 0, delta: { content: partial }, finish_reason: null }] })}\n\n`));
            init?.signal?.addEventListener("abort", () => {
              hangingAborted = true;
              controller.error(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return baseFetch(input as string, init);
    }) as unknown as typeof fetch;

    const ctx = makeCtx([SYSTEM, { role: "user", content: GOAL }], conversationId);
    ctx.fusionConfig = { ...kernelConfig, kernel: { ...kernelConfig.kernel!, wave_quorum: 0.67, straggler_grace_seconds: 1 } };
    const started = performance.now();
    const result = await router.route(ctx);
    const elapsed = performance.now() - started;

    expect(hangingAborted).toBe(true);
    expect(elapsed).toBeLessThan(15_000);
    // The hanging proposer is cancelled (early settle: glm + kimi already agree);
    // the pipelined verifier for its truncated candidate may be cancelled too
    // once the first two verdicts accept.
    expect(result.fusionTrace?.kernel?.["cancelledWorkers"] as number).toBeGreaterThanOrEqual(1);
    expect(result.fusionTrace?.kernel?.["earlySettles"] as number).toBeGreaterThanOrEqual(1);
    expect(result.fusionTrace?.kernel?.["truncatedWorkers"]).toBe(1);
    // The truncated deepseek proposal still reached synthesis as a candidate note.
    expect(result.subagentResults.some((n) => n.subTask.focus_area.includes("deepseek"))).toBe(true);
    // Truncated work is not cached: only glm + kimi proposals (+ intent + verifiers) were stored.
    const cachedProposals = getOperationalDb().query("SELECT model_routing FROM fusion_kernel_work WHERE kind = 'proposer'").all() as Array<{ model_routing: string }>;
    expect(cachedProposals.map((r) => r.model_routing).sort()).toEqual(["glm-5.3", "kimi-k3"]);
  });

  it("serves Anthropic-protocol clients: fast path converts the request and emits Anthropic events; search synthesizes through the fuser", async () => {
    const conversationId = `conv-anthropic-${Date.now()}`;
    const captured = emptyCaptured();
    installFetch(captured);
    const anthropicCfg: FusionConfig = { ...kernelConfig, fusion: { ...kernelConfig.fusion, wire_protocol: "anthropic" } };
    const makeAnthropicCtx = (messages: unknown[], extra: Record<string, unknown> = {}): FusionRequestContext => ({
      logicalModel: "fusion-max",
      fusionConfig: anthropicCfg,
      requestData: { model: "fusion-max", max_tokens: 200, system: SYSTEM.content, messages, ...extra },
      clientProtocol: "anthropic",
      messages,
      conversationId,
      requestId: `req-${Math.random().toString(16).slice(2)}`,
    });

    // Fast path, non-streaming: request converted to OpenAI shape upstream, assembled back.
    const trivial = [{ role: "user", content: "What is 2+2?" }];
    const fast = await router.route(makeAnthropicCtx(trivial, { reasoning_effort: "low" }));
    expect(fast.content).toContain("Final synthesized answer");
    expect(fast.wireProtocol).toBe("anthropic");
    const fastBody = captured.synthesis[0]!;
    expect(fastBody["stream"]).toBe(true);
    expect(fastBody["model"]).toBe("up-flash");
    const upstreamRoles = (fastBody["messages"] as Array<Record<string, unknown>>).map((m) => m["role"]);
    expect(upstreamRoles[0]).toBe("system");

    // Fast path, streaming: events are Anthropic SSE.
    const streamed = await collectStream(router.stream(makeAnthropicCtx(trivial, { reasoning_effort: "low", stream: true })));
    expect(streamed).toContain("event: message_start");
    expect(streamed).toContain("text_delta");
    expect(streamed).toContain("event: message_stop");
    expect(streamed).not.toContain("chat.completion.chunk");

    // Search turn (F2) streams Anthropic thinking narration + synthesized text.
    const goal = [{ role: "user", content: GOAL }];
    const search = await collectStream(router.stream(makeAnthropicCtx(goal, { reasoning_effort: "high", stream: true })));
    expect(search).toContain("thinking_delta");
    expect(search).toContain("Kernel: new task");
    expect(search).toContain("Final synthesized answer");
    expect(captured.proposer.length).toBe(3);
  });

  it("adapts verification to the final-answer vote: unanimous → one audit, split → every candidate audited", async () => {
    const adaptiveCfg: FusionConfig = { ...kernelConfig, kernel: { ...kernelConfig.kernel!, adaptive_verification: true } };
    const mathPrompt = [{ role: "user", content: "How many positive integers n <= 1000 make n^5 - n divisible by 60? End with FINAL: <answer>." }];

    const unanimous = emptyCaptured();
    installFetch(unanimous, { finalAnswers: { glm: "750", kimi: "750", deepseek: "$750$" } });
    const ctxA = makeCtx(mathPrompt, `conv-vote-unanimous-${Date.now()}`);
    ctxA.fusionConfig = adaptiveCfg;
    delete (ctxA.requestData as Record<string, unknown>)["tools"];
    const a = await router.route(ctxA);
    expect(unanimous.proposer).toHaveLength(3);
    expect(unanimous.verifier).toHaveLength(1);
    const synthA = allText(unanimous.synthesis[0]!["messages"] as unknown[]);
    expect(synthA).toContain("FINAL ANSWER VOTE");
    expect(synthA).toContain("UNANIMOUS");
    expect(a.fusionTrace?.kernel?.["agreement"] as number).toBeGreaterThanOrEqual(0.7);

    const split = emptyCaptured();
    installFetch(split, { finalAnswers: { glm: "750", kimi: "500", deepseek: "750" } });
    const ctxB = makeCtx(mathPrompt, `conv-vote-split-${Date.now()}`);
    ctxB.fusionConfig = adaptiveCfg;
    delete (ctxB.requestData as Record<string, unknown>)["tools"];
    await router.route(ctxB);
    expect(split.proposer).toHaveLength(3);
    expect(split.verifier).toHaveLength(3);
    const synthB = allText(split.synthesis[0]!["messages"] as unknown[]);
    expect(synthB).toContain("SPLIT");
    expect(synthB).toContain("\"500\"");
  });

  it("uses the fast path for trivial fresh requests and still records the ledger for later continuation", async () => {
    const conversationId = `conv-fast-${Date.now()}`;
    const captured = emptyCaptured();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      captured.models.push(String(body["model"]));
      return chatResponse({ role: "assistant", content: "4" }, body["model"]);
    }) as unknown as typeof fetch;
    const ctx = makeCtx([{ role: "user", content: "What is 2+2?" }], conversationId, { reasoning_effort: "low" });
    delete (ctx.requestData as Record<string, unknown>)["tools"];
    const result = await router.route(ctx);
    expect(result.content).toBe("4");
    expect(captured.models).toEqual(["up-flash"]);
    expect(result.fusionTrace?.kernel?.["mode"]).toBe("fast");
    const session = getOperationalDb().query("SELECT ledger_json FROM fusion_kernel_sessions WHERE conversation_id = ?").get(conversationId) as { ledger_json: string };
    expect(JSON.parse(session.ledger_json)["intent"]["goal"]).toBe("What is 2+2?");
  });
});
