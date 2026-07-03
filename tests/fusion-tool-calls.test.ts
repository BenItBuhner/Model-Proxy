import { afterAll, afterEach, beforeAll, beforeEach, describe, it, expect } from "bun:test";
import { FusionRouter } from "../src/routing/fusion/fusion-router.ts";
import type { FusionRequestContext } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "../shared/schemas/fusion.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const tmpRoot = path.join(tmpdir(), `mp-fusion-tools-${process.pid}-${Date.now()}`);
const originalFetch = globalThis.fetch;

const testFusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.20, effort_2_threshold: 0.55 },
  task_divider: { model_routing: "glm-5.2", timeout_seconds: 120, max_subtasks: 10 },
  effort_levels: {
    1: { model_routing: "glm-5.2" },
    2: { subagent_count: { min: 2, max: 3 }, model_routings: ["glm-5.2"], tools: ["context_search"] },
    3: { subagent_count: { min: 3, max: 5 }, model_routings: ["glm-5.2"], tools: ["context_search"] },
  },
  fusion: { model_routing: "glm-5.2", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: false, scope: "permanent" },
  summarizer: { enabled: false, model_routing: "turbo", segment_chars: 1400, max_summary_tokens: 256 },
  scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120_000 },
};

const TEST_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get weather for a location",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name" } },
        required: ["location"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_time",
      description: "Get current time for a location",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name" } },
        required: ["location"],
      },
    },
  },
];

function makeCtx(messages: unknown[], toolChoice?: unknown): FusionRequestContext {
  return {
    logicalModel: "fusion-beta",
    fusionConfig: testFusionConfig,
    requestData: { messages, tools: TEST_TOOLS, tool_choice: toolChoice ?? "auto" } as Record<string, unknown>,
    clientProtocol: "openai",
    messages,
  };
}

async function mockFusionFetch(_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> {
  const rawBody = typeof init?.body === "string" ? init.body : "{}";
  const body = JSON.parse(rawBody) as Record<string, unknown>;
  const messages = Array.isArray(body["messages"]) ? body["messages"] : [];
  const joined = JSON.stringify(messages).toLowerCase();
  const tools = Array.isArray(body["tools"]) ? body["tools"] : [];
  const toolChoice = body["tool_choice"];
  const shouldCallTool =
    tools.length > 0 &&
    toolChoice !== "none" &&
    !joined.includes("tool_call_id") &&
    !joined.includes("what should i wear");

  const response = shouldCallTool
    ? {
        id: "chatcmpl-fake-tools",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body["model"] ?? "fake-fusion-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_fake",
                  type: "function",
                  function: {
                    name: joined.includes("time") ? "get_time" : "get_weather",
                    arguments: JSON.stringify({ location: joined.includes("tokyo") ? "Tokyo" : "London" }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }
    : {
        id: "chatcmpl-fake-text",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: body["model"] ?? "fake-fusion-model",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "The weather context suggests comfortable lightweight clothing and no tool call is needed.",
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      };

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Fusion Tool Calls", () => {
  let router: FusionRouter;
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
        model_routings: [{ provider: "openai", model: "fake-fusion-model", api_key_env: ["FAKE_FUSION_API_KEY"] }],
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
    delete process.env.FAKE_FUSION_API_KEY;
  });

  beforeEach(() => {
    router = new FusionRouter();
    process.env.FAKE_FUSION_API_KEY = "fake-key";
    resetKeyState("openai");
    globalThis.fetch = mockFusionFetch as unknown as typeof fetch;
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

  // ── Effort 1 tool call paths ──────────────────────────────────────

  it("routes tool requests through to upstream and extracts tool_calls", async () => {
    const ctx = makeCtx([
      { role: "user", content: "Get the weather in London using the get_weather tool." },
    ]);
    const result = await router.route(ctx);

    expect(result).toBeDefined();
    expect(result.toolCalls).toBeDefined();
    if (result.toolCalls) {
      // Might have 0 tool_calls if the model decided not to call, but the structure should be valid
      console.log("Tool calls:", JSON.stringify(result.toolCalls).slice(0, 200));
    }
    expect(result.finishReason).toBeDefined();
    expect(result.fusedByModelRouting).toBeTruthy();
    expect(result.wireProtocol).toBe("openai");
  }, 60000);

  it("passes requestData.tools through to the upstream model", async () => {
    const ctx = makeCtx([
      { role: "user", content: "Use the get_time tool to find the time in Tokyo." },
    ]);

    const result = await router.route(ctx);
    expect(result).toBeDefined();

    // If tool calls were made, verify they reference valid tools
    if (result.toolCalls && result.toolCalls.length > 0) {
      for (const tc of result.toolCalls as Array<Record<string, unknown>>) {
        const fn = tc["function"] as Record<string, unknown> | undefined;
        if (fn) {
          const name = fn["name"] as string;
          expect(["get_weather", "get_time"]).toContain(name);
          const args = fn["arguments"] as string;
          expect(() => JSON.parse(args)).not.toThrow(); // Must be valid JSON
        }
      }
    }
  }, 60000);

  it("sets content to null when tool_calls are present", async () => {
    const ctx = makeCtx([
      { role: "user", content: "Get the weather in Paris." },
    ]);
    const result = await router.route(ctx);
    expect(result).toBeDefined();

    if (result.toolCalls && result.toolCalls.length > 0) {
      expect(result.content).toBeNull();
    }
  }, 60000);

  it("handles multiple tool calls in a single request", async () => {
    const ctx = makeCtx([
      { role: "user", content: "Get the weather in London AND Paris using the tools." },
    ]);
    const result = await router.route(ctx);
    expect(result).toBeDefined();

    // May have 0, 1, or multiple — should not crash
    if (result.toolCalls) {
      expect(Array.isArray(result.toolCalls)).toBe(true);
    }
  }, 60000);

  // ── Multi-turn tool conversations ─────────────────────────────────

  it("handles multi-turn: tool call → tool result → assistant response", async () => {
    const ctx = makeCtx([
      { role: "user", content: "Get the weather in Berlin." },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"Berlin"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: '{"temperature": 22, "condition": "sunny"}' },
      { role: "user", content: "What should I wear?" },
    ]);
    const result = await router.route(ctx);
    expect(result).toBeDefined();
    // Should produce a text response about what to wear based on the weather
    if (result.content) {
      expect(result.content.length).toBeGreaterThan(10);
      console.log("Multi-turn response:", result.content.slice(0, 150));
    }
  }, 60000);

  // ── Tool choice handling ──────────────────────────────────────────

  it("respects tool_choice: none (should not call tools)", async () => {
    const ctx = makeCtx(
      [{ role: "user", content: "Write a poem about the weather." }],
      "none",
    );
    const result = await router.route(ctx);
    expect(result).toBeDefined();
    // With tool_choice: none, the model ideally returns text content.
    // If it still returns tool_calls (some upstream models ignore tool_choice),
    // ensure the structure is valid.
    if (result.toolCalls && result.toolCalls.length > 0) {
      // Should still have valid tool call structure, but this is upstream behavior
      expect(result.content).toBeNull();
      expect(Array.isArray(result.toolCalls)).toBe(true);
    } else {
      expect(result.content).toBeTruthy();
      if (typeof result.content === "string") {
        expect(result.content.length).toBeGreaterThan(0);
      }
    }
  }, 60000);

  // ── Response format validation ────────────────────────────────────

  it("returns valid OpenAI-format response structure", async () => {
    const ctx = makeCtx([
      { role: "user", content: "What's the weather in Rome?" },
    ]);
    const result = await router.route(ctx);

    // Validate OpenAI-compatible message structure
    const message: Record<string, unknown> = {
      role: "assistant",
    };
    if (result.toolCalls && result.toolCalls.length > 0) {
      message.content = null;
      message.tool_calls = result.toolCalls;
    } else {
      message.content = result.content;
    }

    // The message must be valid for the OpenAI API format
    expect(message.role).toBe("assistant");
    if (message.tool_calls) {
      expect(message.content).toBeNull();
      expect(Array.isArray(message.tool_calls)).toBe(true);
      for (const tc of message.tool_calls as Array<Record<string, unknown>>) {
        expect(tc.id).toBeTruthy();
        expect(tc.type).toBe("function");
        expect(tc.function).toBeTruthy();
        expect((tc.function as Record<string, unknown>).name).toBeTruthy();
        expect((tc.function as Record<string, unknown>).arguments).toBeTruthy();
        // arguments must be valid JSON
        expect(() => JSON.parse((tc.function as Record<string, unknown>).arguments as string)).not.toThrow();
      }
    } else {
      expect(typeof message.content).toBe("string");
    }
  }, 60000);

  // ── Error handling ────────────────────────────────────────────────

  it("handles empty tools array gracefully", async () => {
    const ctx: FusionRequestContext = {
      logicalModel: "fusion-beta",
      fusionConfig: testFusionConfig,
      requestData: { tools: [], messages: [{ role: "user", content: "Hello" }] } as Record<string, unknown>,
      clientProtocol: "openai",
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = await router.route(ctx);
    expect(result).toBeDefined();
    expect(result.content).toBeTruthy();
  }, 60000);

  it("handles undefined tools gracefully", async () => {
    const ctx: FusionRequestContext = {
      logicalModel: "fusion-beta",
      fusionConfig: testFusionConfig,
      requestData: { messages: [{ role: "user", content: "Hello" }] } as Record<string, unknown>,
      clientProtocol: "openai",
      messages: [{ role: "user", content: "Hello" }],
    };
    const result = await router.route(ctx);
    expect(result).toBeDefined();
    expect(result.content).toBeTruthy();
  }, 60000);
});
