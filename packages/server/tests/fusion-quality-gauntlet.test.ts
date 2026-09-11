import { rmWithRetry } from "./support.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import type { FusionRequestContext } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "@model-proxy/contracts/schemas/fusion.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { scoreFusionQuality } from "../src/routing/fusion/quality-scorecard.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const tmpRoot = path.join(tmpdir(), `mp-fusion-quality-${process.pid}-${Date.now()}`);
const cacheRoot = path.join(tmpRoot, "xdg");
const originalFetch = globalThis.fetch;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
let scenarioFingerprint = "";

process.env.XDG_DATA_HOME = cacheRoot;
process.env.HOME = cacheRoot;

const { FusionRouter } = await import("../src/routing/fusion/fusion-router.ts");

const routeModels = {
  "glm-5.2": "fake-glm-5-2",
  "glm-5.1-precision": "fake-glm-5-1-precision",
  "kimi-k2.7-code": "fake-kimi-k2-7-code",
  "deepseek-v4-pro": "fake-deepseek-v4-pro",
  "minimax-m2.7": "fake-minimax-m2-7",
  "mimo-v2.5-pro": "fake-mimo-v2-5-pro",
} as const;

const finalTools = Array.from({ length: 64 }, (_, index) => ({
  type: "function",
  function: {
    name: `final_engineering_tool_${index + 1}`,
    description: `Tool ${index + 1} available only to the final synthesis model.`,
    parameters: {
      type: "object",
      properties: {
        target: { type: "string" },
        rationale: { type: "string" },
      },
      required: ["target"],
    },
  },
}));

const qualityFusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.15, effort_2_threshold: 0.5 },
  task_divider: { model_routing: "glm-5.2", timeout_seconds: 30, max_subtasks: 5 },
  effort_levels: {
    1: { model_routing: "glm-5.2" },
    2: {
      subagent_count: { min: 2, max: 3 },
      model_routings: ["glm-5.2", "kimi-k2.7-code", "deepseek-v4-pro"],
      tools: [],
    },
    3: {
      subagent_count: { min: 3, max: 5 },
      model_routings: ["glm-5.1-precision", "kimi-k2.7-code", "deepseek-v4-pro", "minimax-m2.7", "mimo-v2.5-pro"],
      tools: [],
    },
  },
  fusion: { model_routing: "glm-5.2", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: true, scope: "permanent" },
  summarizer: { enabled: false, model_routing: "glm-5.2", segment_chars: 1400, max_summary_tokens: 256 },
  scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120_000 },
  engine: "legacy",
};

function makeCtx(): FusionRequestContext {
  const messages = [
    {
      role: "system",
      content: "You are evaluating a Fusion model on software-engineering and mathematics quality.",
    },
    {
      role: "user",
      content: [
        "Design a TypeScript request scheduler that proves no starvation for high-priority tasks.",
        "Include a correctness argument using invariants, complexity analysis, edge-case testing, and a concise migration plan.",
        "You may need final tools later, but internal subagents must only reason from the supplied context.",
      ].join("\n"),
    },
    {
      role: "tool",
      tool_call_id: "call_repo_context",
      content: JSON.stringify({
        files: [
          "src/routing/fusion/fusion-router.ts",
          "src/routing/fallback.ts",
          "src/storage/operational-db.ts",
          "tests/fusion-quality-gauntlet.test.ts",
        ],
        mathConstraints: [
          "Prove bounded wait by a ranking function.",
          "Analyze worst-case work per scheduling tick.",
          "Identify counterexamples for naive priority queues.",
        ],
      }),
    },
  ];

  return {
    logicalModel: "fusion-beta",
    fusionConfig: qualityFusionConfig,
    requestData: {
      messages,
      tools: finalTools,
      tool_choice: "auto",
      reasoning_effort: "high",
    },
    clientProtocol: "openai",
    messages,
    conversationId: `quality-gauntlet-conversation-${scenarioFingerprint}`,
    inputFingerprint: `quality-gauntlet-input-${scenarioFingerprint}`,
  };
}

function chatResponse(message: Record<string, unknown>, model: unknown): Response {
  return new Response(JSON.stringify({
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "fake-fusion-model",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: 160, completion_tokens: 40, total_tokens: 200 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function streamContentResponse(parts: string[]): Response {
  const chunks = parts.map((part) => {
    const chunk = {
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake-fusion-subagent",
      choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  });
  return new Response(`${chunks.join("")}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function extractMessageText(messages: unknown[]): string {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

describe("Fusion quality gauntlet", () => {
  let router: InstanceType<typeof FusionRouter>;

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpRoot, "models"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "providers"), { recursive: true });

    for (const [logicalName, fakeModel] of Object.entries(routeModels)) {
      fs.writeFileSync(
        path.join(tmpRoot, "models", `${logicalName}.json`),
        JSON.stringify({
          logical_name: logicalName,
          timeout_seconds: 5,
          context_window: logicalName.includes("precision") ? 96_000 : 64_000,
          default_cooldown_seconds: 0,
          model_routings: [{
            provider: "openai",
            model: fakeModel,
            api_key_env: ["FAKE_FUSION_QUALITY_API_KEY"],
          }],
          fallback_model_routings: [],
        }),
      );
    }

    fs.writeFileSync(
      path.join(tmpRoot, "providers", "openai.json"),
      JSON.stringify({
        name: "openai",
        enabled: true,
        api_keys: { env_var_patterns: ["FAKE_FUSION_QUALITY_API_KEY"] },
        endpoints: {
          base_url: "https://fake-fusion-quality.local",
          completions: "/v1/chat/completions",
          compatible_format: "openai",
        },
        authentication: { type: "bearer", header_name: "Authorization", header_format: "Bearer {api_key}" },
        request_config: { timeout_seconds: 5, max_retries: 0, retry_on_status: [] },
      }),
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    closeOperationalDbForTests();
    rmWithRetry(tmpRoot, { recursive: true, force: true });
    delete process.env.FAKE_FUSION_QUALITY_API_KEY;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  beforeEach(() => {
    scenarioFingerprint = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    rmWithRetry(path.join(cacheRoot, "model-proxy"), { recursive: true, force: true });
    router = new FusionRouter();
    process.env.FAKE_FUSION_QUALITY_API_KEY = "fake-key";
    resetKeyState("openai");
    setPrimaryConfigDirForTests(tmpRoot);
  });

  afterEach(() => {
    setPrimaryConfigDirForTests(undefined);
    globalThis.fetch = originalFetch;
  });

  it("keeps SWE/math advisory reasoning diverse, terse, sealed, and final-tool authoritative", async () => {
    const captured: {
      divider: Array<Record<string, unknown>>;
      subagent: Array<Record<string, unknown>>;
      fuser: Array<Record<string, unknown>>;
      finalPrompt: string;
    } = { divider: [], subagent: [], fuser: [], finalPrompt: "" };

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
      const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
      const model = String(body["model"] ?? "");

      if (tools.some((tool) => JSON.stringify(tool).includes("divide_task"))) {
        captured.divider.push(body);
        return chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_divide_quality",
            type: "function",
            function: {
              name: "divide_task",
              arguments: JSON.stringify({
                sub_tasks: [
                  {
                    id: "scheduler-architecture",
                    description: "Analyze the TypeScript scheduler architecture and migration path.",
                    focus_area: "software architecture",
                    suggested_model_routing: "kimi-k2.7-code",
                  },
                  {
                    id: "starvation-proof",
                    description: "Build a concise invariant and ranking-function proof for no starvation.",
                    focus_area: "mathematical proof",
                    suggested_model_routing: "glm-5.1-precision",
                  },
                  {
                    id: "complexity-counterexamples",
                    description: "Analyze asymptotic cost and counterexamples for naive priority queues.",
                    focus_area: "algorithmic analysis",
                    suggested_model_routing: "deepseek-v4-pro",
                  },
                  {
                    id: "test-risk-review",
                    description: "Identify edge-case tests and operational risks for rollout.",
                    focus_area: "testing risk",
                    suggested_model_routing: "minimax-m2.7",
                  },
                ],
              }),
            },
          }],
        }, body["model"]);
      }

      if (body["stream"] === true && body["tool_choice"] === "none") {
        captured.subagent.push(body);
        const recommendationByModel: Record<string, string> = {
          "fake-kimi-k2-7-code": "Recommendation: isolate scheduling policy behind a small interface and migrate call sites one adapter at a time.",
          "fake-glm-5-1-precision": "Recommendation: prove bounded wait with a rank tuple of priority debt and arrival index, then show every tick decreases some waiting task rank.",
          "fake-deepseek-v4-pro": "Recommendation: prefer a binary heap plus aging counter; reject naive strict-priority queues because low-priority tasks can wait forever.",
          "fake-minimax-m2-7": "Recommendation: test empty queues, equal priority bursts, cancellation during promotion, and recovery after persisted-state replay.",
        };
        return streamContentResponse([
          `I created files and ran benchmarks for ${model}.\n`,
          `${recommendationByModel[model] ?? "Recommendation: keep the analysis terse and focused."}\n`,
          "<tool_call>{\"name\":\"final_engineering_tool_1\",\"arguments\":{\"target\":\"subagent\"}}</tool_call>",
        ]);
      }

      captured.fuser.push(body);
      const finalPrompt = extractMessageText(messages);
      captured.finalPrompt = finalPrompt;
      expect(tools).toHaveLength(64);
      expect(finalPrompt.length).toBeLessThan(9_000);
      expect(finalPrompt).toContain("Focus: software architecture");
      expect(finalPrompt).toContain("Focus: mathematical proof");
      expect(finalPrompt).toContain("Focus: algorithmic analysis");
      expect(finalPrompt).toContain("Focus: testing risk");
      expect(finalPrompt).toContain("Model route: kimi-k2.7-code");
      expect(finalPrompt).toContain("Model route: glm-5.1-precision");
      expect(finalPrompt).toContain("Model route: deepseek-v4-pro");
      expect(finalPrompt).toContain("Model route: minimax-m2.7");
      expect(finalPrompt).toContain("bounded wait");
      expect(finalPrompt).toContain("binary heap plus aging counter");
      expect(finalPrompt).not.toContain("I created files");
      expect(finalPrompt).not.toContain("ran benchmarks");
      expect(finalPrompt).not.toContain("<tool_call>");
      expect(finalPrompt).not.toContain("final_engineering_tool_1");
      return chatResponse({
        role: "assistant",
        content: "Quality gauntlet synthesis: combine adapter migration, rank-proof invariants, heap aging, and edge-case rollout tests.",
      }, body["model"]);
    }) as unknown as typeof fetch;

    const result = await router.route(makeCtx());

    expect(result.content).toContain("rank-proof invariants");
    expect(result.cacheHit).toBe(false);
    expect(result.subagentResults).toHaveLength(4);
    expect(result.subagentResults.map((item) => item.usedModelRouting)).toEqual([
      "kimi-k2.7-code",
      "glm-5.1-precision",
      "deepseek-v4-pro",
      "minimax-m2.7",
    ]);
    expect(new Set(result.subagentResults.map((item) => item.usedModelRouting)).size).toBe(4);
    expect(result.fusionTrace?.subTaskCount).toBe(4);
    expect(result.fusionTrace?.subTasks?.map((task) => task.focus)).toEqual([
      "software architecture",
      "mathematical proof",
      "algorithmic analysis",
      "testing risk",
    ]);
    expect(result.fusionTrace?.subagentDetails?.every((detail) =>
      detail.contextPack?.logicalContextWindow === 10_000_000)).toBe(true);
    const scorecard = scoreFusionQuality({
      subtasks: result.subagentResults.map((item) => ({
        focus: item.subTask.focus_area,
        model: item.usedModelRouting,
        description: item.subTask.description,
      })),
      advisories: result.subagentResults.map((item) => ({
        focus: item.subTask.focus_area,
        model: item.usedModelRouting,
        content: item.content,
        contextCoveragePercent: item.contextPack?.coveragePercent,
      })),
      finalPrompt: captured.finalPrompt,
      finalToolCount: finalTools.length,
      subagentRequests: captured.subagent.map((request) => ({
        hasTools: request["tools"] !== undefined,
        toolChoice: typeof request["tool_choice"] === "string" ? request["tool_choice"] : undefined,
        stream: request["stream"] === true,
      })),
    });
    expect(scorecard.overall).toBeGreaterThanOrEqual(0.95);
    expect(scorecard.domainCoverage).toBe(1);
    expect(scorecard.modelDiversity).toBe(1);
    expect(scorecard.advisoryDiversity).toBe(1);
    expect(scorecard.contextCoverage).toBe(1);
    expect(scorecard.terseHandoff).toBe(1);
    expect(scorecard.safety).toBe(1);
    expect(scorecard.finalToolAuthority).toBe(1);
    expect(scorecard.details.failedChecks).toEqual([]);
    expect(captured.divider).toHaveLength(1);
    expect(captured.subagent).toHaveLength(4);
    expect(captured.fuser).toHaveLength(1);

    for (const request of captured.subagent) {
      expect(request["tools"]).toBeUndefined();
      expect(request["tool_choice"]).toBe("none");
      expect(request["stream"]).toBe(true);
      expect(extractMessageText(request["messages"] as unknown[])).toContain("You have NO tools");
    }
  }, 60_000);
});
