import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { FusionRequestContext } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "../shared/schemas/fusion.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { closeOperationalDbForTests, getOperationalDb } from "../src/storage/operational-db.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const tmpRoot = path.join(tmpdir(), `mp-fusion-complex-${process.pid}-${Date.now()}`);
const cacheRoot = path.join(tmpRoot, "xdg");
const originalFetch = globalThis.fetch;
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalHome = process.env.HOME;
let scenarioFingerprint = "";

process.env.XDG_DATA_HOME = cacheRoot;
process.env.HOME = cacheRoot;

const { FusionRouter } = await import("../src/routing/fusion/fusion-router.ts");

const manyTools = Array.from({ length: 9 }, (_, index) => ({
  type: "function",
  function: {
    name: `project_tool_${index + 1}`,
    description: `Tool ${index + 1} available to the final synthesis model only`,
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
}));

const testFusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.2, effort_2_threshold: 0.55 },
  task_divider: { model_routing: "glm-5.2", timeout_seconds: 30, max_subtasks: 4 },
  effort_levels: {
    1: { model_routing: "glm-5.2" },
    2: { subagent_count: { min: 2, max: 3 }, model_routings: ["glm-5.2"], tools: [] },
    3: { subagent_count: { min: 3, max: 4 }, model_routings: ["glm-5.2"], tools: [] },
  },
  fusion: { model_routing: "glm-5.2", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: true, scope: "permanent" },
  summarizer: { enabled: false, model_routing: "glm-5.2", segment_chars: 1400, max_summary_tokens: 256 },
  scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120_000 },
};

function makeCtx(): FusionRequestContext {
  const messages = [
    {
      role: "system",
      content: "You are helping triage a TypeScript proxy repository.",
    },
    {
      role: "user",
      content: [
        "Plan a safe repository cleanup and implementation strategy.",
        "Consider GitHub branch hygiene, stale PRs, test coverage, deploy readiness, and developer clone experience.",
        "This is a complex agentic turn with many possible tools, but subagents must only research and summarize.",
      ].join("\n"),
    },
    {
      role: "tool",
      tool_call_id: "call_repo_scan",
      content: JSON.stringify({
        files: ["src/routing/fusion/fusion-router.ts", "src/routing/fusion/subagent-executor.ts"],
        notes: "Large codebase with branch cleanup concerns and implementation follow-through.",
      }),
    },
  ];
  return {
    logicalModel: "fusion-beta",
    fusionConfig: testFusionConfig,
    requestData: {
      messages,
      tools: manyTools,
      tool_choice: "auto",
      reasoning_effort: "high",
    },
    clientProtocol: "openai",
    messages,
    conversationId: `complex-cache-conversation-${scenarioFingerprint}`,
    inputFingerprint: `complex-cache-input-${scenarioFingerprint}`,
  };
}

function chatResponse(message: Record<string, unknown>, model: unknown): Response {
  return new Response(JSON.stringify({
    id: `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: model ?? "fake-fusion-model",
    choices: [{ index: 0, message, finish_reason: "stop" }],
    usage: { prompt_tokens: 111, completion_tokens: 37, total_tokens: 148 },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function streamResponse(text: string): Response {
  const chunk = {
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-fusion-model",
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function streamContentResponse(parts: string[]): Response {
  const chunks = parts.map((part) => {
    const chunk = {
      id: "chatcmpl-stream",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fake-fusion-model",
      choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  });
  const done = {
    id: "chatcmpl-stream",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-fusion-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return new Response(`${chunks.join("")}data: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function extractMessageText(messages: unknown[]): string {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

async function collectStream(gen: AsyncGenerator<string, void, unknown>): Promise<string> {
  let out = "";
  for await (const chunk of gen) out += chunk;
  return out;
}

describe("Fusion complex scenarios", () => {
  let router: InstanceType<typeof FusionRouter>;
  let savedModelSearchPaths: string[] | undefined;
  let savedProviderSearchPaths: string[] | undefined;

  beforeAll(() => {
    fs.mkdirSync(path.join(tmpRoot, "models"), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, "providers"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRoot, "models", "glm-5.2.json"),
      JSON.stringify({
        logical_name: "glm-5.2",
        timeout_seconds: 5,
        default_cooldown_seconds: 0,
        model_routings: [{
          provider: "openai",
          model: "fake-fusion-model",
          api_key_env: ["FAKE_FUSION_API_KEY"],
          context_window: 64_000,
        }],
        fallback_model_routings: [],
      }),
    );
    fs.writeFileSync(
      path.join(tmpRoot, "providers", "openai.json"),
      JSON.stringify({
        name: "openai",
        enabled: true,
        api_keys: { env_var_patterns: ["FAKE_FUSION_API_KEY"] },
        endpoints: {
          base_url: "https://fake-fusion.local",
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
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.FAKE_FUSION_API_KEY;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  beforeEach(() => {
    scenarioFingerprint = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    fs.rmSync(path.join(cacheRoot, "model-proxy"), { recursive: true, force: true });
    router = new FusionRouter();
    process.env.FAKE_FUSION_API_KEY = "fake-key";
    resetKeyState("openai");
    const modelLoader = modelConfigLoader as unknown as { searchPaths?: string[] };
    const providerLoader = providerConfigLoader as unknown as { searchPaths?: string[] };
    if (modelLoader.searchPaths !== undefined) {
      savedModelSearchPaths = [...modelLoader.searchPaths];
      modelLoader.searchPaths = [tmpRoot];
    }
    if (providerLoader.searchPaths !== undefined) {
      savedProviderSearchPaths = [...providerLoader.searchPaths];
      providerLoader.searchPaths = [tmpRoot];
    }
  });

  afterEach(() => {
    const modelLoader = modelConfigLoader as unknown as { searchPaths?: string[] };
    const providerLoader = providerConfigLoader as unknown as { searchPaths?: string[] };
    if (savedModelSearchPaths !== undefined) modelLoader.searchPaths = savedModelSearchPaths;
    if (savedProviderSearchPaths !== undefined) providerLoader.searchPaths = savedProviderSearchPaths;
    savedModelSearchPaths = undefined;
    savedProviderSearchPaths = undefined;
    globalThis.fetch = originalFetch;
  });

  it("spawns reasoning-only subagents for complex tool-heavy turns and reuses cached results on repeat", async () => {
    const captured: {
      divider: Array<Record<string, unknown>>;
      subagent: Array<Record<string, unknown>>;
      fuser: Array<Record<string, unknown>>;
    } = { divider: [], subagent: [], fuser: [] };

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
      const messages = Array.isArray(body["messages"]) ? body["messages"] : [];

      if (tools.some((tool) => JSON.stringify(tool).includes("divide_task"))) {
        captured.divider.push(body);
        return chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_divide",
            type: "function",
            function: {
              name: "divide_task",
              arguments: JSON.stringify({
                sub_tasks: [
                  {
                    id: "repo-hygiene",
                    description: "Analyze stale branch and PR cleanup risks and recommend a safe sequence.",
                    focus_area: "repository",
                    suggested_model_routing: "glm-5.2",
                  },
                  {
                    id: "fusion-contract",
                    description: "Analyze fusion subagent contract and identify verification expectations.",
                    focus_area: "testing",
                    suggested_model_routing: "glm-5.2",
                  },
                ],
              }),
            },
          }],
        }, body["model"]);
      }

      if (body["stream"] === true) {
        captured.subagent.push(body);
        const promptText = extractMessageText(messages);
        const label = promptText.includes("stale branch") ? "repository" : "testing";
        return streamResponse(`${label} analysis recommends focused cleanup. {"tool_calls":[{"function":{"name":"fake"}}]}`);
      }

      captured.fuser.push(body);
      const text = extractMessageText(messages);
      expect(text).toContain("[Research Focus: repository]");
      expect(text).toContain("[Research Focus: testing]");
      expect(text).toContain("analysis recommends focused cleanup");
      expect(text).not.toContain("\"tool_calls\"");
      return chatResponse({
        role: "assistant",
        content: captured.fuser.length === 1
          ? "Final fused cleanup plan from fresh subagent work."
          : "Final fused cleanup plan from cached subagent work.",
      }, body["model"]);
    }) as unknown as typeof fetch;

    const first = await router.route(makeCtx());

    expect(first.content).toContain("fresh subagent work");
    expect(first.cacheHit).toBe(false);
    expect(first.subagentResults).toHaveLength(2);
    expect(first.fusionTrace?.subTaskCount).toBe(2);
    expect(first.fusionTrace?.subTasks?.map((task) => task.focus)).toEqual(["repository", "testing"]);
    expect(first.fusionTrace?.subTasks?.[0]?.description).toContain("stale branch and PR cleanup");
    expect(first.fusionTrace?.subagentDetails?.[0]?.contextWindow).toBe(64_000);
    expect(first.fusionTrace?.subagentDetails?.[0]?.inputBudgetTokens).toBe(48_000);
    expect(first.fusionTrace?.subagentDetails?.[0]?.outputBudgetTokens).toBe(16_000);
    expect(first.fusionTrace?.subagentDetails?.[0]?.contextMessageCount).toBe(3);
    expect(first.fusionTrace?.subagentDetails?.[0]?.droppedMessageCount).toBe(0);
    expect(first.fusionTrace?.subagentDetails?.[0]?.packedContextTokens).toBeGreaterThan(0);
    expect(first.fusionTrace?.subagentDetails?.[0]?.contextPack?.logicalContextWindow).toBe(10_000_000);
    expect(first.fusionTrace?.subagentDetails?.[0]?.contextPack?.selectedRanges).toBe("1-3");
    expect(first.fusionTrace?.steps.some((step) => step.label === "Subagent Decision")).toBe(true);
    expect(first.fusionTrace?.steps.some((step) => step.label === "Subagent Execution")).toBe(true);
    const fusionRunId = first.fusionTrace?.fusionRunId;
    expect(typeof fusionRunId).toBe("string");
    const db = getOperationalDb();
    const persistedRun = db
      .query("SELECT status, cache_hit AS cacheHit FROM fusion_runs WHERE fusion_run_id = ?")
      .get(fusionRunId as string) as { status: string; cacheHit: number } | undefined;
    const persistedSubagents = db
      .query("SELECT COUNT(*) AS count FROM fusion_subagent_runs WHERE fusion_run_id = ?")
      .get(fusionRunId as string) as { count: number } | undefined;
    expect(persistedRun?.status).toBe("completed");
    expect(persistedRun?.cacheHit).toBe(0);
    expect(persistedSubagents?.count).toBe(2);
    expect(captured.divider).toHaveLength(1);
    expect(captured.subagent).toHaveLength(2);
    expect(captured.fuser).toHaveLength(1);

    for (const request of captured.subagent) {
      expect(request["tools"]).toBeUndefined();
      expect(request["tool_choice"]).toBe("none");
      expect(request["stream"]).toBe(true);
      expect(request["max_tokens"]).toBeLessThanOrEqual(16_000);
      expect(extractMessageText(request["messages"] as unknown[])).toContain("You have NO tools");
    }

    const second = await router.route(makeCtx());

    expect(second.content).toContain("cached subagent work");
    expect(second.cacheHit).toBe(true);
    expect(second.subagentResults).toHaveLength(2);
    expect(second.cacheKey).toBe(first.cacheKey);
    expect(second.fusionTrace?.cacheHit).toBe(true);
    expect(second.fusionTrace?.subTasks?.map((task) => task.focus)).toEqual(["repository", "testing"]);
    expect(second.fusionTrace?.steps.some((step) => step.label === "Pre-Divider Cache Lookup")).toBe(true);
    expect(captured.divider).toHaveLength(1);
    expect(captured.subagent).toHaveLength(2);
    expect(captured.fuser).toHaveLength(2);
  }, 60_000);

  it("does not cache incomplete subagent result sets", async () => {
    const captured: {
      divider: Array<Record<string, unknown>>;
      subagent: Array<Record<string, unknown>>;
      fuser: Array<Record<string, unknown>>;
    } = { divider: [], subagent: [], fuser: [] };

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
      const messages = Array.isArray(body["messages"]) ? body["messages"] : [];

      if (tools.some((tool) => JSON.stringify(tool).includes("divide_task"))) {
        captured.divider.push(body);
        return chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_divide",
            type: "function",
            function: {
              name: "divide_task",
              arguments: JSON.stringify({
                sub_tasks: [
                  {
                    id: "repo-hygiene",
                    description: "Analyze stale branch and PR cleanup risks and recommend a safe sequence.",
                    focus_area: "repository",
                    suggested_model_routing: "glm-5.2",
                  },
                  {
                    id: "fusion-contract",
                    description: "Analyze fusion subagent contract and identify verification expectations.",
                    focus_area: "testing",
                    suggested_model_routing: "glm-5.2",
                  },
                ],
              }),
            },
          }],
        }, body["model"]);
      }

      if (body["stream"] === true && body["tool_choice"] === "none") {
        captured.subagent.push(body);
        const promptText = extractMessageText(messages);
        if (promptText.includes("fusion subagent contract")) {
          return streamContentResponse([""]);
        }
        return streamResponse("Repository hygiene analysis completed successfully.");
      }

      captured.fuser.push(body);
      return chatResponse({
        role: "assistant",
        content: `Final fused response ${captured.fuser.length}.`,
      }, body["model"]);
    }) as unknown as typeof fetch;

    const first = await router.route(makeCtx());
    const second = await router.route(makeCtx());

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(false);
    expect(first.subagentResults.some((result) => !result.success)).toBe(true);
    expect(second.subagentResults.some((result) => !result.success)).toBe(true);
    expect(captured.divider).toHaveLength(2);
    expect(captured.fuser).toHaveLength(2);
    expect(captured.subagent.length).toBeGreaterThanOrEqual(8);
  }, 60_000);

  it("streams summaries, preserves adaptive trace metadata, and reuses cached subagent work", async () => {
    const captured: {
      divider: Array<Record<string, unknown>>;
      subagent: Array<Record<string, unknown>>;
      summarizer: Array<Record<string, unknown>>;
      fuser: Array<Record<string, unknown>>;
    } = { divider: [], subagent: [], summarizer: [], fuser: [] };

    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
      const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
      const messageText = extractMessageText(messages);

      if (tools.some((tool) => JSON.stringify(tool).includes("divide_task"))) {
        captured.divider.push(body);
        return chatResponse({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_divide_stream",
            type: "function",
            function: {
              name: "divide_task",
              arguments: JSON.stringify({
                sub_tasks: [
                  {
                    id: "repo-hygiene",
                    description: "Analyze stale branch and PR cleanup risks and recommend a safe sequence.",
                    focus_area: "repository",
                    suggested_model_routing: "glm-5.2",
                  },
                  {
                    id: "fusion-contract",
                    description: "Analyze fusion subagent contract and identify verification expectations.",
                    focus_area: "testing",
                    suggested_model_routing: "glm-5.2",
                  },
                ],
              }),
            },
          }],
        }, body["model"]);
      }

      if (body["stream"] === true && messageText.includes("live reasoning summarizer")) {
        captured.summarizer.push(body);
        return streamContentResponse(["Reviewing repository cleanup risks and Fusion contract checks."]);
      }

      if (body["stream"] === true && body["tool_choice"] === "none") {
        captured.subagent.push(body);
        const label = messageText.includes("stale branch") ? "repository" : "testing";
        return streamContentResponse([
          `${label} analysis recommends staged cleanup, stale PR closure, and verification before merge. `,
          "It explicitly avoids file creation and only provides advisory reasoning for the fuser. ".repeat(3),
        ]);
      }

      if (body["stream"] === true) {
        captured.fuser.push(body);
        const text = extractMessageText(messages);
        expect(text).toContain("[Research Focus: repository]");
        expect(text).toContain("[Research Focus: testing]");
        return streamContentResponse([
          captured.fuser.length === 1
            ? "Fresh streamed fusion answer."
            : "Cached streamed fusion answer.",
        ]);
      }

      throw new Error(`unexpected mocked request: ${JSON.stringify(body).slice(0, 300)}`);
    }) as unknown as typeof fetch;

    const streamingConfig: FusionConfig = {
      ...testFusionConfig,
      summarizer: { enabled: true, model_routing: "glm-5.2", segment_chars: 200, max_summary_tokens: 128 },
    };
    const firstCtx = makeCtx();
    firstCtx.fusionConfig = streamingConfig;
    firstCtx.requestData = { ...firstCtx.requestData, stream: true };
    const events: unknown[] = [];
    firstCtx.obsEmit = (event) => events.push(event);

    const firstStream = await collectStream(router.stream(firstCtx));

    expect(firstStream).toContain("Fresh streamed fusion answer.");
    expect(captured.divider).toHaveLength(1);
    expect(captured.subagent).toHaveLength(2);
    expect(captured.summarizer.length).toBeGreaterThan(0);
    expect(captured.fuser).toHaveLength(1);
    expect(firstCtx.streamFusionTrace?.["cacheHit"]).toBe(false);
    const firstTraceTasks = firstCtx.streamFusionTrace?.["subTasks"] as Array<Record<string, unknown>> | undefined;
    expect(firstTraceTasks?.map((task) => task["focus"])).toEqual(["repository", "testing"]);
    const firstDetails = firstCtx.streamFusionTrace?.["subagentDetails"] as Array<Record<string, unknown>> | undefined;
    expect(firstDetails?.[0]?.["contextWindow"]).toBe(64_000);
    expect(firstDetails?.[0]?.["inputBudgetTokens"]).toBe(48_000);
    expect(firstDetails?.[0]?.["outputBudgetTokens"]).toBe(16_000);
    expect(firstDetails?.[0]?.["contextMessageCount"]).toBe(3);
    expect(firstDetails?.[0]?.["droppedMessageCount"]).toBe(0);
    expect(firstDetails?.[0]?.["packedContextTokens"]).toBeGreaterThan(0);
    const firstContextPack = firstDetails?.[0]?.["contextPack"] as Record<string, unknown> | undefined;
    expect(firstContextPack?.["selectedRanges"]).toBe("1-3");
    expect(firstContextPack?.["coveragePercent"]).toBe(100);
    expect(events.some((event) => {
      const evt = event as Record<string, unknown>;
      return evt["type"] === "fusion.summary" && String(evt["text"] ?? "").includes("repository cleanup risks");
    })).toBe(true);

    const secondCtx = makeCtx();
    secondCtx.fusionConfig = streamingConfig;
    secondCtx.requestData = { ...secondCtx.requestData, stream: true };
    const secondEvents: unknown[] = [];
    secondCtx.obsEmit = (event) => secondEvents.push(event);

    const secondStream = await collectStream(router.stream(secondCtx));

    expect(secondStream).toContain("Cached streamed fusion answer.");
    expect(secondCtx.streamFusionTrace?.["cacheHit"]).toBe(true);
    expect(secondCtx.streamFusionTrace?.["cacheKey"]).toBe(firstCtx.streamFusionTrace?.["cacheKey"]);
    const secondSteps = secondCtx.streamFusionTrace?.["steps"] as Array<Record<string, unknown>> | undefined;
    expect(secondSteps?.some((step) => step["type"] === "cache_lookup")).toBe(true);
    expect(secondSteps?.some((step) => step["type"] === "synthesis")).toBe(true);
    expect(captured.divider).toHaveLength(1);
    expect(captured.subagent).toHaveLength(2);
    expect(captured.fuser).toHaveLength(2);
    expect(secondEvents.some((event) => {
      const evt = event as Record<string, unknown>;
      return evt["type"] === "fusion.cache" && evt["kind"] === "request" && evt["hit"] === true;
    })).toBe(true);
    expect(secondEvents.some((event) => {
      const evt = event as Record<string, unknown>;
      return evt["type"] === "fusion.phase" &&
        evt["phase"] === "subagent_execution" &&
        (evt["detail"] as Record<string, unknown> | undefined)?.["decision"] === "reuse";
    })).toBe(true);
    const reusedSubagentEvents = secondEvents.filter((event) => {
      const evt = event as Record<string, unknown>;
      return evt["type"] === "fusion.subagent" &&
        (evt["detail"] as Record<string, unknown> | undefined)?.["stage"] === "cache_reused";
    });
    expect(reusedSubagentEvents).toHaveLength(2);
    expect((reusedSubagentEvents[0] as Record<string, unknown>)["status"]).toBe("completed");
  }, 60_000);
});
