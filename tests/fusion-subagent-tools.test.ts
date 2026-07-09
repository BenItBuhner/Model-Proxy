import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { SubagentExecutor } from "../src/routing/fusion/subagent-executor.ts";
import { searchConversationContext } from "../src/routing/fusion/context-search.ts";
import type { FusionRequestContext, SubTask } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "../shared/schemas/fusion.ts";
import type { SummarySegment } from "../src/routing/fusion/reasoning-summarizer.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const tmpRoot = path.join(tmpdir(), `mp-fusion-subagent-${process.pid}-${Date.now()}`);
const originalFetch = globalThis.fetch;

const testFusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.2, effort_2_threshold: 0.55 },
  task_divider: { model_routing: "glm-5.2", timeout_seconds: 30, max_subtasks: 10 },
  effort_levels: {
    1: { model_routing: "glm-5.2" },
    2: { subagent_count: { min: 1, max: 3 }, model_routings: ["glm-5.2"], tools: ["context_search"] },
    3: { subagent_count: { min: 1, max: 5 }, model_routings: ["glm-5.2"], tools: ["context_search"] },
  },
  fusion: { model_routing: "glm-5.2", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: false, scope: "permanent" },
  summarizer: { enabled: true, model_routing: "turbo", segment_chars: 600, max_summary_tokens: 256 },
  scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120_000 },
};

function makeCtx(messages: unknown[]): FusionRequestContext {
  return {
    logicalModel: "fusion-beta",
    fusionConfig: testFusionConfig,
    requestData: { messages },
    clientProtocol: "openai",
    messages,
    runtimeEffort: 2,
  };
}

function sseResponse(events: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(event));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function contentEvents(text: string): string[] {
  return [
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  ];
}

function toolCallEvents(name: string, args: Record<string, unknown>): string[] {
  const argText = JSON.stringify(args);
  return [
    `data: ${JSON.stringify({ id: "t1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: "" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "t1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argText } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "t1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  ];
}

const subTask: SubTask = {
  id: "research-1",
  description: "Analyze the retry behavior of the fallback router.",
  focus_area: "research",
  suggested_model_routing: "glm-5.2",
};

describe("SubagentExecutor reasoning-only subagents", () => {
  let executor: SubagentExecutor;
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
        context_window: 64000,
        default_cooldown_seconds: 0,
        model_routings: [{ provider: "openai", model: "fake-subagent-model", api_key_env: ["FAKE_SUBAGENT_API_KEY"] }],
        fallback_model_routings: [],
      }),
    );
    fs.writeFileSync(
      path.join(tmpRoot, "providers", "openai.json"),
      JSON.stringify({
        name: "openai",
        enabled: true,
        api_keys: { env_var_patterns: ["FAKE_SUBAGENT_API_KEY"] },
        endpoints: {
          base_url: "https://fake-subagent.local",
          completions: "/v1/chat/completions",
          compatible_format: "openai",
        },
        authentication: {
          type: "bearer",
          header_name: "Authorization",
          header_format: "Bearer {api_key}",
        },
        request_config: { timeout_seconds: 5, max_retries: 0, retry_on_status: [] },
      }),
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.FAKE_SUBAGENT_API_KEY;
  });

  beforeEach(() => {
    executor = new SubagentExecutor();
    process.env.FAKE_SUBAGENT_API_KEY = "fake-key";
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

  it("does not declare tools upstream and supplies a pre-triaged context briefing", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    const emitted: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(body);
      return sseResponse(contentEvents("The fallback router retries transient failures with exponential backoff; recommend tightening the retry predicate."));
    }) as unknown as typeof fetch;

    const ctx = makeCtx([
      { role: "user", content: "The fallback router retry behavior seems wrong when providers time out." },
    ]);
    ctx.obsEmit = (event) => emitted.push(event as Record<string, unknown>);
    const results = await executor.execute(ctx, [subTask]);

    expect(results.length).toBe(1);
    expect(results[0].success).toBe(true);
    expect(results[0].content).toContain("exponential backoff");
    const completed = emitted.find((event) =>
      event["type"] === "fusion.subagent" && event["status"] === "completed");
    const completedDetail = completed?.["detail"] as Record<string, unknown> | undefined;
    expect(completedDetail?.["stage"]).toBe("completed");
    expect(completedDetail?.["contextWindow"]).toBe(64_000);
    expect(completedDetail?.["inputBudgetTokens"]).toBe(48_000);
    expect(completedDetail?.["outputBudgetTokens"]).toBe(16_000);
    expect(completedDetail?.["contextMessageCount"]).toBe(1);
    expect(completedDetail?.["droppedMessageCount"]).toBe(0);
    expect(completedDetail?.["packedContextTokens"]).toBeGreaterThan(0);

    const firstBody = capturedBodies[0];
    expect("tools" in firstBody).toBe(false);
    expect(firstBody["tool_choice"]).toBe("none");
    const messages = firstBody["messages"] as Array<Record<string, unknown>>;
    expect(messages.some((m) => m["role"] === "tool")).toBe(false);
    const briefing = String(messages[1]?.["content"] ?? "");
    expect(briefing).toContain("Fusion proxy context briefing");
    expect(briefing).toContain("Relevant excerpts selected by the proxy");
    expect(briefing).toContain("retry behavior");
    expect(firstBody["max_tokens"]).toBe(16000);
  }, 20000);

  it("packs large contexts with opening, relevant, middle-anchor, and recent coverage", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(body);
      return sseResponse(contentEvents("The context pack includes broad coverage across the conversation."));
    }) as unknown as typeof fetch;

    const filler = "context filler ".repeat(80);
    const messages = Array.from({ length: 140 }, (_, index) => ({
      role: index % 7 === 0 ? "assistant" : "user",
      content: `message-${index} ${filler}`,
    }));
    messages[0] = { role: "user", content: `OPENING_SENTINEL ${filler}` };
    messages[70] = {
      role: "user",
      content: `RELEVANT_RETRY_SENTINEL fallback router retry behavior ${filler}`,
    };
    messages[93] = {
      role: "assistant",
      content: `MIDDLE_ANCHOR_SENTINEL unrelated architecture note ${filler}`,
    };
    messages[139] = { role: "user", content: `RECENT_SENTINEL final user update ${filler}` };

    const ctx = makeCtx(messages);
    const results = await executor.execute(ctx, [subTask]);

    expect(results[0].success).toBe(true);
    expect(results[0].contextMessageCount).toBeGreaterThan(20);
    expect(results[0].droppedMessageCount).toBeGreaterThan(90);
    expect(results[0].packedContextTokens).toBeGreaterThan(1000);
    const body = capturedBodies[0];
    const packedMessages = body["messages"] as Array<Record<string, unknown>>;
    const packedText = JSON.stringify(packedMessages);
    expect(packedText).toContain("OPENING_SENTINEL");
    expect(packedText).toContain("RELEVANT_RETRY_SENTINEL");
    expect(packedText).toContain("MIDDLE_ANCHOR_SENTINEL");
    expect(packedText).toContain("RECENT_SENTINEL");
    expect(packedText).toContain("Stratified context mix");
    expect(packedText).toContain("messages were omitted");
    expect(packedMessages.length).toBeLessThan(messages.length);
    expect(body["max_tokens"]).toBe(16000);
  }, 20000);

  it("preserves high-scoring relevant context when budget pruning large packets", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(body);
      return sseResponse(contentEvents("The pruned packet retained the important diagnostic context."));
    }) as unknown as typeof fetch;

    const hugeFiller = "low priority context filler ".repeat(500);
    const messages: Array<Record<string, unknown>> = Array.from({ length: 120 }, (_, index) => ({
      role: index % 5 === 0 ? "assistant" : "user",
      content: `bulk-message-${index} ${hugeFiller}`,
    }));
    messages[0] = { role: "user", content: `OPENING_PRUNE_SENTINEL ${hugeFiller}` };
    messages[58] = {
      role: "tool",
      tool_call_id: "call_retry_scan",
      content: `PRUNE_RELEVANT_SENTINEL fallback router retry behavior root cause: provider timeout status is misclassified. ${hugeFiller}`,
    };
    messages[119] = { role: "user", content: `RECENT_PRUNE_SENTINEL final instruction ${hugeFiller}` };

    const ctx = makeCtx(messages);
    const results = await executor.execute(ctx, [subTask]);

    expect(results[0].success).toBe(true);
    expect(results[0].packedContextTokens).toBeLessThanOrEqual(48_000);
    expect(results[0].droppedMessageCount).toBeGreaterThan(70);
    const body = capturedBodies[0];
    const packedMessages = body["messages"] as Array<Record<string, unknown>>;
    const packedText = JSON.stringify(packedMessages);
    expect(packedText).toContain("OPENING_PRUNE_SENTINEL");
    expect(packedText).toContain("PRUNE_RELEVANT_SENTINEL");
    expect(packedText).toContain("RECENT_PRUNE_SENTINEL");
    expect(packedMessages.length).toBeLessThan(messages.length / 2);
  }, 20000);

  it("truncates an oversized selected message so the packet fits the route budget", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(body);
      return sseResponse(contentEvents("The oversized context packet was reduced to fit the subagent route budget."));
    }) as unknown as typeof fetch;

    const oversized = [
      "fallback router retry behavior ".repeat(30_000),
      "OVERSIZED_TAIL_SENTINEL final diagnostic result",
    ].join("\n");
    const ctx = makeCtx([
      {
        role: "user",
        content: `OVERSIZED_RELEVANT_SENTINEL ${oversized}`,
      },
    ]);
    const results = await executor.execute(ctx, [subTask]);

    expect(results[0].success).toBe(true);
    expect(results[0].packedContextTokens).toBeLessThanOrEqual(48_000);
    const body = capturedBodies[0];
    const messages = body["messages"] as Array<Record<string, unknown>>;
    const packetText = JSON.stringify(messages);
    expect(packetText).toContain("OVERSIZED_RELEVANT_SENTINEL");
    expect(packetText).toContain("OVERSIZED_TAIL_SENTINEL");
    expect(packetText).toContain("context message truncated to fit subagent route budget");
    expect(packetText.length).toBeLessThan(oversized.length);
    expect(body["max_tokens"]).toBe(16_000);
  }, 20000);

  it("retries hallucinated tool-call-only output and still gets final analysis", async () => {
    const capturedBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capturedBodies.push(body);
      const messages = body["messages"] as Array<Record<string, unknown>>;
      const retryNudge = JSON.stringify(messages).includes("you have no tools");
      if (!retryNudge) {
        // Model hallucinates a harness tool it saw in the transcript
        return sseResponse(toolCallEvents("write_file", { path: "src/x.ts", content: "..." }));
      }
      return sseResponse(contentEvents("Understood; providing plain-text analysis of the change instead of attempting edits."));
    }) as unknown as typeof fetch;

    const ctx = makeCtx([
      { role: "user", content: "Fix the retry bug in the router." },
    ]);
    const results = await executor.execute(ctx, [subTask]);

    expect(results[0].success).toBe(true);
    expect(results[0].content).toContain("plain-text analysis");

    const followupBody = capturedBodies[1];
    expect("tools" in followupBody).toBe(false);
    expect(followupBody["tool_choice"]).toBe("none");
    const followupMessages = followupBody["messages"] as Array<Record<string, unknown>>;
    expect(followupMessages.some((m) => m["role"] === "tool")).toBe(false);
    expect(JSON.stringify(followupMessages)).toContain("Do not call or describe tool calls");
  }, 20000);

  it("strips hallucinated inline tool-call JSON from subagent content and segments", async () => {
    globalThis.fetch = (async () => {
      return sseResponse(contentEvents(
        'Analysis paragraph one about the retry predicate. <tool_call>{"name": "run_shell", "arguments": {"cmd": "bun test"}}</tool_call> Analysis paragraph two with the recommendation.',
      ));
    }) as unknown as typeof fetch;

    const segments: SummarySegment[] = [];
    const ctx = makeCtx([{ role: "user", content: "Investigate the retry predicate." }]);
    const results = await executor.execute(ctx, [subTask], {
      onSegment: (segment) => segments.push(segment),
    });

    expect(results[0].success).toBe(true);
    expect(results[0].content).not.toContain("run_shell");
    expect(results[0].content).toContain("paragraph one");
    expect(results[0].content).toContain("paragraph two");
    for (const segment of segments) {
      expect(segment.text).not.toContain("run_shell");
    }
  }, 20000);

  it("strips impossible action claims from subagent content and segments", async () => {
    globalThis.fetch = (async () => {
      return sseResponse(contentEvents(
        "I edited src/routing/fusion/fallback.ts and ran bun test.\n\nRecommendation: update the retry predicate to treat transport resets as retryable.",
      ));
    }) as unknown as typeof fetch;

    const segments: SummarySegment[] = [];
    const ctx = makeCtx([{ role: "user", content: "Investigate retry behavior." }]);
    const results = await executor.execute(ctx, [subTask], {
      onSegment: (segment) => segments.push(segment),
    });

    expect(results[0].success).toBe(true);
    expect(results[0].content).not.toContain("I edited");
    expect(results[0].content).not.toContain("ran bun test");
    expect(results[0].content).toContain("subagent invalid action claim removed");
    expect(results[0].content).toContain("Recommendation: update the retry predicate");
    for (const segment of segments) {
      expect(segment.text).not.toContain("I edited");
      expect(segment.text).not.toContain("ran bun test");
      expect(segment.text).toContain("Recommendation: update the retry predicate");
    }
  }, 20000);

  it("subagent system prompt spells out the sealed environment", async () => {
    let systemPrompt = "";
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const messages = body["messages"] as Array<Record<string, unknown>>;
      systemPrompt = String(messages[0]?.["content"] ?? "");
      return sseResponse(contentEvents("Complete analysis text for the assigned focus area."));
    }) as unknown as typeof fetch;

    const ctx = makeCtx([{ role: "user", content: "Analyze this." }]);
    await executor.execute(ctx, [subTask]);

    expect(systemPrompt).toContain("RESEARCH AND REASONING subagent");
    expect(systemPrompt).toContain("sealed analysis sandbox");
    expect(systemPrompt).toContain("CANNOT create, edit, delete, or run anything");
    expect(systemPrompt).toContain("You have NO tools");
    expect(systemPrompt).toContain("There is no tool-calling interface");
    expect(systemPrompt).toContain("NEVER claim to have created, modified, executed");
  }, 20000);
});

describe("searchConversationContext", () => {
  it("searches conversation context by keywords", () => {
    const messages = [
      { role: "user", content: "The websocket handler drops frames under load." },
      { role: "assistant", content: "I will inspect the frame buffer logic." },
    ];
    const result = searchConversationContext(messages, "websocket frames");
    expect(result).toContain("websocket handler");
    expect(result).toContain("role=user");
  });

  it("returns coverage metadata and stratified recent matches for large conversations", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `message-${index} unrelated deployment notes`,
    }));
    messages[2] = { role: "user", content: "EARLY_SENTINEL websocket frame buffer backpressure details" };
    messages[14] = { role: "assistant", content: "MIDDLE_SENTINEL websocket frames retry queue analysis" };
    messages[29] = { role: "user", content: "RECENT_SENTINEL frames still drop under websocket load" };

    const result = searchConversationContext(messages, "websocket frames");

    expect(result).toContain("Coverage: 3/30 messages matched");
    expect(result).toContain("Matched roles:");
    expect(result).toContain("Returning 3 stratified excerpt");
    expect(result).toContain("EARLY_SENTINEL");
    expect(result).toContain("MIDDLE_SENTINEL");
    expect(result).toContain("RECENT_SENTINEL");
  });

  it("extracts searchable text from structured message content", () => {
    const messages = [
      {
        role: "user",
        content: [
          { type: "text", text: "Structured payload mentions fallback retries." },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ];

    const result = searchConversationContext(messages, "fallback retries");

    expect(result).toContain("Structured payload mentions fallback retries");
    expect(result).toContain("[message 1/1, role=user");
  });
});
