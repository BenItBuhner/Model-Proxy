import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { eventSink } from "../src/observability/event-sink.ts";
import type {
  AnthropicCallArgs,
  BaseProvider,
  OpenAICallArgs,
  ProviderCallContext,
} from "../src/providers/base.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { resetProxyState } from "../src/providers/egress-proxy-manager.ts";
import { ProviderAPIError } from "../src/providers/errors.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import { createApp } from "../src/server/app.ts";
import { resetRequestLogForTests } from "../src/server/request-log.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const tmpRoot = join(tmpdir(), `mp-events-${process.pid}-${Date.now()}`);

mkdirSync(join(tmpRoot, "models"), { recursive: true });
mkdirSync(join(tmpRoot, "providers"), { recursive: true });
setPrimaryConfigDirForTests(tmpRoot);



class FakeProvider implements BaseProvider {
  readonly providerName = "fakee";
  readonly wireProtocol = "openai" as const;
  readonly config = {} as BaseProvider["config"];

  static responses: Array<Record<string, unknown> | Promise<Record<string, unknown>> | Error> = [];
  static streamResponses: Array<string | Error> = [];
  static streamResponder:
    | ((args: OpenAICallArgs, ctx: ProviderCallContext) => string | Error | Promise<string | Error>)
    | undefined;
  static calls: Array<{ args: OpenAICallArgs; ctx: ProviderCallContext }> = [];
  static streamCalls: Array<{ args: OpenAICallArgs; ctx: ProviderCallContext }> = [];

  async callOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    FakeProvider.calls.push({ args, ctx });
    const next = FakeProvider.responses.shift();
    if (next === undefined) throw new Error("no response queued");
    if (next instanceof Error) throw next;
    return await next;
  }

  async *streamOpenAI(
    args: OpenAICallArgs,
    ctx: ProviderCallContext,
  ): AsyncGenerator<string, void, unknown> {
    FakeProvider.streamCalls.push({ args, ctx });
    const next = FakeProvider.streamResponder !== undefined
      ? await FakeProvider.streamResponder(args, ctx)
      : FakeProvider.streamResponses.shift();
    if (next === undefined) throw new Error("no stream response queued");
    if (next instanceof Error) throw next;
    const chunk = {
      id: `chatcmpl-stream-${FakeProvider.streamCalls.length}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: args.model,
      choices: [{ index: 0, delta: { content: next }, finish_reason: null }],
    };
    const done = {
      id: `chatcmpl-stream-${FakeProvider.streamCalls.length}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: args.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    yield `data: ${JSON.stringify(chunk)}\n\n`;
    yield `data: ${JSON.stringify(done)}\n\n`;
    yield "data: [DONE]\n\n";
  }

  async callAnthropic(
    _args: AnthropicCallArgs,
    _ctx: ProviderCallContext,
  ): Promise<Record<string, unknown>> {
    throw new Error("not implemented");
  }
}

beforeAll(() => {
  process.env.CLIENT_API_KEY = "events-test";
  process.env.FAKEE_API_KEY = "fakee-key-aaaa";
  process.env.FAKEE_PROXY_API_KEY = "fakee-proxy-key-zzzz";
  process.env.FAKEE_PROXY_EGRESS_PROXY_1 = "http://proxy-one:8080";
  process.env.FAKEE_PROXY_EGRESS_PROXY_2 = "http://user:pass@proxy-two:8080";
  setStorageRootForTests(join(tmpRoot, ".storage"));

  writeFileSync(
    join(tmpRoot, "providers", "fakee.json"),
    JSON.stringify({
      name: "fakee",
      display_name: "Fake E",
      enabled: true,
      api_keys: { env_var_patterns: ["FAKEE_API_KEY"] },
      endpoints: {
        base_url: "https://fakee.local/v1",
        completions: "/chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
    }),
  );

  writeFileSync(
    join(tmpRoot, "providers", "fakee-proxy.json"),
    JSON.stringify({
      name: "fakee-proxy",
      display_name: "Fake E Proxy",
      enabled: true,
      api_keys: { env_var_patterns: ["FAKEE_PROXY_API_KEY"] },
      endpoints: {
        base_url: "https://fakee-proxy.local/v1",
        completions: "/chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
      egress_proxies: {
        enabled: true,
        env_var_patterns: ["FAKEE_PROXY_EGRESS_PROXY_{INDEX}"],
        cooldown_seconds: 0,
      },
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fakee-model.json"),
    JSON.stringify({
      logical_name: "fakee-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fakee", model: "fakee-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fakee-proxy-model.json"),
    JSON.stringify({
      logical_name: "fakee-proxy-model",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fakee-proxy", model: "fakee-proxy-backend", wire_protocol: "openai" },
      ],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fusion-e2e.json"),
    JSON.stringify({
      logical_name: "fusion-e2e",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fakee", model: "fakee-fusion-placeholder", wire_protocol: "openai" },
      ],
      fusion: {
        enabled: true,
        context_window: 10_000_000,
        complexity_scoring: { effort_1_threshold: 0.2, effort_2_threshold: 0.55 },
        task_divider: { model_routing: "fakee-model", timeout_seconds: 5, max_subtasks: 2 },
        effort_levels: {
          1: { model_routing: "fakee-model" },
          2: { subagent_count: { min: 2, max: 2 }, model_routings: ["fakee-model"], tools: [] },
          3: { subagent_count: { min: 2, max: 2 }, model_routings: ["fakee-model"], tools: [] },
        },
        fusion: { model_routing: "fakee-model", strategy: "sequential_append", wire_protocol: "openai" },
        summarizer: { enabled: false, model_routing: "fakee-model", segment_chars: 1400, max_summary_tokens: 256 },
        cache: { enabled: false, scope: "permanent" },
        scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120000 },
      },
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "fusion-e2e-summary.json"),
    JSON.stringify({
      logical_name: "fusion-e2e-summary",
      timeout_seconds: 5,
      default_cooldown_seconds: 0,
      model_routings: [
        { provider: "fakee", model: "fakee-fusion-placeholder", wire_protocol: "openai" },
      ],
      fusion: {
        enabled: true,
        context_window: 10_000_000,
        complexity_scoring: { effort_1_threshold: 0.2, effort_2_threshold: 0.55 },
        task_divider: { model_routing: "fakee-model", timeout_seconds: 5, max_subtasks: 2 },
        effort_levels: {
          1: { model_routing: "fakee-model" },
          2: { subagent_count: { min: 2, max: 2 }, model_routings: ["fakee-model"], tools: [] },
          3: { subagent_count: { min: 2, max: 2 }, model_routings: ["fakee-model"], tools: [] },
        },
        fusion: { model_routing: "fakee-model", strategy: "sequential_append", wire_protocol: "openai" },
        summarizer: { enabled: true, model_routing: "fakee-model", segment_chars: 200, max_summary_tokens: 128 },
        cache: { enabled: false, scope: "permanent" },
        scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120000 },
      },
    }),
  );

  providerRegistry.registerProvider("fakee", () => new FakeProvider());
  providerRegistry.registerProvider("fakee-proxy", () => new FakeProvider());
});

afterAll(() => {
  providerRegistry.unregisterProvider("fakee");
  providerRegistry.unregisterProvider("fakee-proxy");
  resetKeyState("fakee");
  resetKeyState("fakee-proxy");
  resetProxyState("fakee-proxy");
  delete process.env.CLIENT_API_KEY;
  delete process.env.FAKEE_API_KEY;
  delete process.env.FAKEE_PROXY_API_KEY;
  delete process.env.FAKEE_PROXY_EGRESS_PROXY_1;
  delete process.env.FAKEE_PROXY_EGRESS_PROXY_2;
  setPrimaryConfigDirForTests(undefined);
  setStorageRootForTests(undefined);
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore windows file-lock issues
  }
});

afterEach(() => {
  FakeProvider.responses = [];
  FakeProvider.streamResponses = [];
  FakeProvider.streamResponder = undefined;
  FakeProvider.calls = [];
  FakeProvider.streamCalls = [];
  eventSink._resetForTests();
  resetRequestLogForTests();
  rmSync(join(tmpRoot, ".storage"), { recursive: true, force: true });
});

const app = createApp();
const auth = { Authorization: "Bearer events-test" } as Record<string, string>;

describe("request-scoped event tracing", () => {
  test("snapshot endpoint returns the full timeline for a completed request", async () => {
    FakeProvider.responses = [
      {
        id: "c-1",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    ];

    const id = "test-req-aaa";
    const inferRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify({
        model: "fakee-model",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(inferRes.status).toBe(200);

    const snapRes = await app.request(
      `/v1/admin/events/${encodeURIComponent(id)}`,
      { headers: auth },
    );
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      requestId: string;
      finished: boolean;
      events: Array<{
        type: string;
        keyHint?: string;
        apiKeyEnvVar?: string;
      }>;
    };
    expect(snap.requestId).toBe(id);
    expect(snap.finished).toBe(true);
    const types = snap.events.map((e) => e.type);
    expect(types[0]).toBe("request.started");
    expect(types).toContain("route.attempted");
    expect(types).toContain("route.succeeded");
    expect(types[types.length - 1]).toBe("request.finished");
    const routeAttempt = snap.events.find((e) => e.type === "route.attempted");
    expect(routeAttempt?.keyHint).toBe("...aaaa");
    expect(routeAttempt?.apiKeyEnvVar).toBe("(auto)");
  });

  test("fusion request snapshot preserves live pipeline events and completed trace", async () => {
    FakeProvider.responses = [
      {
        id: "divide-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
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
                      id: "repo-context",
                      description: "Analyze repository context and cleanup risk.",
                      focus_area: "repository",
                      suggested_model_routing: "fakee-model",
                    },
                    {
                      id: "fusion-contract",
                      description: "Analyze Fusion subagent and dashboard contract.",
                      focus_area: "fusion",
                      suggested_model_routing: "fakee-model",
                    },
                  ],
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
      {
        id: "fuse-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Final fused answer from HTTP-level Fusion." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 24, completion_tokens: 8, total_tokens: 32 },
      },
    ];
    FakeProvider.streamResponses = [
      "Repository context analysis only. No file edits or tool calls.",
      "Fusion contract analysis only. Subagents remain reasoning-only.",
    ];
    const tools = Array.from({ length: 9 }, (_, index) => ({
      type: "function",
      function: {
        name: `final_tool_${index + 1}`,
        description: "Tool for the final model only.",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    }));

    const id = "test-req-fusion-e2e";
    const inferRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify({
        model: "fusion-e2e",
        messages: [
          { role: "system", content: "You are testing Fusion observability." },
          {
            role: "user",
            content: "Triage a complex repository cleanup and Fusion verification plan with many possible tools.",
          },
        ],
        tools,
        tool_choice: "auto",
        fusion_effort: "high",
      }),
    });
    expect(inferRes.status).toBe(200);
    const body = (await inferRes.json()) as {
      fusion_trace?: {
        fusionRunId?: string;
        subTaskCount?: number;
        cacheHit?: boolean;
        subagentDetails?: Array<{
          contextWindow?: number;
          inputBudgetTokens?: number;
          outputBudgetTokens?: number;
          contextMessageCount?: number;
        }>;
      };
    };
    expect(body.fusion_trace?.fusionRunId).toBeDefined();
    expect(body.fusion_trace?.subTaskCount).toBe(2);
    expect(body.fusion_trace?.cacheHit).toBe(false);
    expect(body.fusion_trace?.subagentDetails?.[0]?.contextWindow).toBe(128_000);
    expect(body.fusion_trace?.subagentDetails?.[0]?.inputBudgetTokens).toBe(96_000);
    expect(body.fusion_trace?.subagentDetails?.[0]?.outputBudgetTokens).toBe(32_000);
    expect(body.fusion_trace?.subagentDetails?.[0]?.contextMessageCount).toBe(2);

    expect(FakeProvider.streamCalls).toHaveLength(2);
    for (const call of FakeProvider.streamCalls) {
      expect(call.args.tools).toBeUndefined();
      expect(call.args.tool_choice).toBe("none");
      expect(call.args.stream).toBe(true);
    }

    const snapRes = await app.request(`/v1/admin/events/${encodeURIComponent(id)}`, { headers: auth });
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      finished: boolean;
      events: Array<{
        type: string;
        status?: string;
        phase?: string;
        fusionTrace?: Record<string, unknown>;
        trace?: Record<string, unknown>;
        detail?: Record<string, unknown>;
      }>;
    };
    expect(snap.finished).toBe(true);
    const types = snap.events.map((event) => event.type);
    expect(types).toContain("fusion.pipeline.started");
    expect(types).toContain("fusion.subtasks");
    expect(types).toContain("fusion.subagent");
    expect(types).toContain("fusion.pipeline.completed");
    expect(types[types.length - 1]).toBe("request.finished");
    const terminalSubagent = snap.events.find((event) =>
      event.type === "fusion.subagent" && event.status === "completed" && event.detail?.["stage"] === "completed");
    expect(terminalSubagent?.detail?.["contextWindow"]).toBe(128_000);
    const completed = snap.events.find((event) => event.type === "fusion.pipeline.completed");
    expect(completed?.trace?.["subTaskCount"]).toBe(2);
    const finished = snap.events.find((event) => event.type === "request.finished");
    expect(finished?.fusionTrace?.["fusionRunId"]).toBe(body.fusion_trace?.fusionRunId);
  });

  test("streaming fusion request snapshot preserves completed live pipeline trace", async () => {
    FakeProvider.responses = [
      {
        id: "divide-stream-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
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
                      id: "stream-repo-context",
                      description: "Analyze repository context during streaming Fusion.",
                      focus_area: "repository",
                      suggested_model_routing: "fakee-model",
                    },
                    {
                      id: "stream-dashboard",
                      description: "Analyze live dashboard event coverage during streaming Fusion.",
                      focus_area: "observability",
                      suggested_model_routing: "fakee-model",
                    },
                  ],
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ];
    FakeProvider.streamResponses = [
      "Streaming repository context analysis only.",
      "Streaming dashboard event analysis only.",
      "Streaming final fused answer from HTTP-level Fusion.",
    ];
    const tools = Array.from({ length: 9 }, (_, index) => ({
      type: "function",
      function: {
        name: `stream_final_tool_${index + 1}`,
        description: "Tool for the streaming final model only.",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    }));

    const id = "test-req-fusion-stream-e2e";
    const inferRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify({
        model: "fusion-e2e",
        messages: [
          { role: "system", content: "You are testing streaming Fusion observability." },
          {
            role: "user",
            content: "Stream a complex Fusion verification pass with many possible final tools.",
          },
        ],
        stream: true,
        tools,
        tool_choice: "auto",
        fusion_effort: "high",
      }),
    });
    expect(inferRes.status).toBe(200);
    const streamText = await inferRes.text();
    expect(streamText).toContain("Streaming final fused answer from HTTP-level Fusion.");
    expect(streamText.trim().endsWith("data: [DONE]")).toBe(true);

    expect(FakeProvider.streamCalls).toHaveLength(3);
    for (const call of FakeProvider.streamCalls.slice(0, 2)) {
      expect(call.args.tools).toBeUndefined();
      expect(call.args.tool_choice).toBe("none");
      expect(call.args.stream).toBe(true);
    }
    expect(FakeProvider.streamCalls[2]?.args.tools).toHaveLength(9);
    expect(FakeProvider.streamCalls[2]?.args.tool_choice).toBe("auto");

    const snapRes = await app.request(`/v1/admin/events/${encodeURIComponent(id)}`, { headers: auth });
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      finished: boolean;
      events: Array<{
        type: string;
        status?: string;
        fusionTrace?: Record<string, unknown>;
        trace?: Record<string, unknown>;
        detail?: Record<string, unknown>;
      }>;
    };
    expect(snap.finished).toBe(true);
    const types = snap.events.map((event) => event.type);
    expect(types).toContain("fusion.pipeline.started");
    expect(types).toContain("fusion.subagent");
    expect(types).toContain("fusion.pipeline.completed");
    expect(types).toContain("route.succeeded");
    expect(types[types.length - 1]).toBe("request.finished");
    const completed = snap.events.find((event) => event.type === "fusion.pipeline.completed");
    const finished = snap.events.find((event) => event.type === "request.finished");
    expect(completed?.trace?.["subTaskCount"]).toBe(2);
    expect(completed?.trace?.["cacheHit"]).toBe(false);
    expect(finished?.fusionTrace?.["subTaskCount"]).toBe(2);
    expect(finished?.fusionTrace?.["fusionRunId"]).toBe(completed?.trace?.["fusionRunId"]);
    const terminalSubagent = snap.events.find((event) =>
      event.type === "fusion.subagent" && event.status === "completed" && event.detail?.["stage"] === "completed");
    expect(terminalSubagent?.detail?.["contextWindow"]).toBe(128_000);
  });

  test("anthropic streaming fusion request uses live pipeline stream and completed trace", async () => {
    FakeProvider.responses = [
      {
        id: "divide-anthropic-stream-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_divide_anthropic_stream",
              type: "function",
              function: {
                name: "divide_task",
                arguments: JSON.stringify({
                  sub_tasks: [
                    {
                      id: "anthropic-stream-repo",
                      description: "Analyze repository readiness through Anthropic streaming Fusion.",
                      focus_area: "repository",
                      suggested_model_routing: "fakee-model",
                    },
                    {
                      id: "anthropic-stream-dashboard",
                      description: "Analyze Anthropic streaming dashboard trace coverage.",
                      focus_area: "observability",
                      suggested_model_routing: "fakee-model",
                    },
                  ],
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ];
    FakeProvider.streamResponses = [
      "Anthropic repository context analysis only.",
      "Anthropic dashboard event analysis only.",
      "Anthropic final fused answer from live Fusion streaming.",
    ];
    const tools = Array.from({ length: 9 }, (_, index) => ({
      name: `anthropic_stream_tool_${index + 1}`,
      description: "Tool for the final Anthropic streaming model only.",
      input_schema: { type: "object", properties: { query: { type: "string" } } },
    }));

    const id = "test-req-fusion-anthropic-stream-e2e";
    const inferRes = await app.request("/v1/messages", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify({
        model: "fusion-e2e",
        max_tokens: 1024,
        stream: true,
        system: "You are testing Anthropic streaming Fusion observability.",
        messages: [{
          role: "user",
          content: "Stream a complex Fusion verification pass through the Anthropic messages API.",
        }],
        tools,
        tool_choice: { type: "auto" },
        fusion_effort: "high",
      }),
    });
    expect(inferRes.status).toBe(200);
    const streamText = await inferRes.text();
    expect(streamText).toContain("event: message_start");
    expect(streamText).toContain("event: content_block_delta");
    expect(streamText).toContain("Anthropic final fused answer from live Fusion streaming.");
    expect(streamText).toContain("event: message_stop");
    expect(streamText).not.toContain("data: [DONE]");

    expect(FakeProvider.streamCalls).toHaveLength(3);
    for (const call of FakeProvider.streamCalls.slice(0, 2)) {
      expect(call.args.tools).toBeUndefined();
      expect(call.args.tool_choice).toBe("none");
      expect(call.args.stream).toBe(true);
    }
    expect(FakeProvider.streamCalls[2]?.args.stream).toBe(true);

    const snapRes = await app.request(`/v1/admin/events/${encodeURIComponent(id)}`, { headers: auth });
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      finished: boolean;
      events: Array<{
        type: string;
        status?: string;
        protocol?: string;
        fusionTrace?: Record<string, unknown>;
        trace?: Record<string, unknown>;
      }>;
    };
    expect(snap.finished).toBe(true);
    const started = snap.events.find((event) => event.type === "request.started");
    expect(started?.protocol).toBe("anthropic");
    const completed = snap.events.find((event) => event.type === "fusion.pipeline.completed");
    const finished = snap.events.find((event) => event.type === "request.finished");
    expect(completed?.trace?.["subTaskCount"]).toBe(2);
    expect(finished?.fusionTrace?.["subTaskCount"]).toBe(2);
    expect(snap.events.at(-1)?.type).toBe("request.finished");
  });

  test("streaming fusion request snapshot includes live summary events", async () => {
    FakeProvider.responses = [
      {
        id: "divide-summary-stream-1",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_divide_summary_stream",
              type: "function",
              function: {
                name: "divide_task",
                arguments: JSON.stringify({
                  sub_tasks: [
                    {
                      id: "stream-summary-repo",
                      description: "Analyze repository cleanup risks during streaming Fusion.",
                      focus_area: "repository",
                      suggested_model_routing: "fakee-model",
                    },
                    {
                      id: "stream-summary-dashboard",
                      description: "Analyze live summary event coverage during streaming Fusion.",
                      focus_area: "observability",
                      suggested_model_routing: "fakee-model",
                    },
                  ],
                }),
              },
            }],
          },
          finish_reason: "tool_calls",
        }],
      },
    ];
    FakeProvider.streamResponder = (args) => {
      const messages = JSON.stringify(args.messages);
      if (messages.includes("live reasoning summarizer")) {
        return "Repository cleanup risks and dashboard event coverage are being checked through the live HTTP trace.";
      }
      if (args.tool_choice === "none" && messages.includes("repository cleanup risks")) {
        return "Repository cleanup analysis is checking stale branches, old pull requests, and main branch readiness. The work confirms subagents stay reasoning-only while final tools remain reserved for synthesis.";
      }
      if (args.tool_choice === "none") {
        return "Dashboard coverage analysis is checking admin event snapshots, live summary events, and terminal Fusion traces. The work verifies completed traces preserve subagent budgets and cache state.";
      }
      return "Streaming final answer with live summary events from HTTP-level Fusion.";
    };
    const tools = Array.from({ length: 9 }, (_, index) => ({
      type: "function",
      function: {
        name: `summary_stream_final_tool_${index + 1}`,
        description: "Tool for the summary-enabled final model only.",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    }));

    const id = "test-req-fusion-summary-stream-e2e";
    const inferRes = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify({
        model: "fusion-e2e-summary",
        messages: [
          { role: "system", content: "You are testing streaming Fusion summaries." },
          {
            role: "user",
            content: "Stream a complex Fusion pass and expose live summary events to the admin dashboard.",
          },
        ],
        stream: true,
        tools,
        tool_choice: "auto",
        fusion_effort: "high",
      }),
    });
    expect(inferRes.status).toBe(200);
    const streamText = await inferRes.text();
    expect(streamText).toContain("Streaming final answer with live summary events");
    expect(streamText).toContain("reasoning_content");
    expect(streamText.trim().endsWith("data: [DONE]")).toBe(true);

    const subagentCalls = FakeProvider.streamCalls.filter((call) => call.args.tool_choice === "none");
    expect(subagentCalls).toHaveLength(2);
    for (const call of subagentCalls) {
      expect(call.args.tools).toBeUndefined();
      expect(call.args.stream).toBe(true);
    }
    const summaryCalls = FakeProvider.streamCalls.filter((call) =>
      JSON.stringify(call.args.messages).includes("live reasoning summarizer"));
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
    const finalCall = FakeProvider.streamCalls.find((call) => Array.isArray(call.args.tools));
    expect(finalCall?.args.tools).toHaveLength(9);
    expect(finalCall?.args.tool_choice).toBe("auto");

    const snapRes = await app.request(`/v1/admin/events/${encodeURIComponent(id)}`, { headers: auth });
    expect(snapRes.status).toBe(200);
    const snap = (await snapRes.json()) as {
      finished: boolean;
      events: Array<{
        type: string;
        status?: string;
        fusionTrace?: Record<string, unknown>;
        trace?: Record<string, unknown>;
        detail?: Record<string, unknown>;
        label?: string;
        text?: string;
      }>;
    };
    expect(snap.finished).toBe(true);
    const summaryEvent = snap.events.find((event) => event.type === "fusion.summary");
    expect(summaryEvent?.label).toContain("stream-summary");
    expect(summaryEvent?.text).toContain("Repository cleanup risks");
    const completed = snap.events.find((event) => event.type === "fusion.pipeline.completed");
    const finished = snap.events.find((event) => event.type === "request.finished");
    const completedSummaries = completed?.trace?.["summaries"] as Array<Record<string, unknown>> | undefined;
    const finishedSummaries = finished?.fusionTrace?.["summaries"] as Array<Record<string, unknown>> | undefined;
    expect(completedSummaries?.some((summary) =>
      String(summary["label"] ?? "").includes("stream-summary") &&
      String(summary["text"] ?? "").includes("Repository cleanup risks")
    )).toBe(true);
    expect(finishedSummaries?.some((summary) =>
      String(summary["text"] ?? "").includes("Repository cleanup risks")
    )).toBe(true);
    expect(completed?.trace?.["subTaskCount"]).toBe(2);
    expect(completed?.trace?.["cacheHit"]).toBe(false);
    expect(finished?.fusionTrace?.["subTaskCount"]).toBe(2);
  });

  test("snapshot 404s for unknown requestId", async () => {
    const res = await app.request("/v1/admin/events/never-existed", {
      headers: auth,
    });
    expect(res.status).toBe(404);
  });

  test("admin logs include a running request before it finishes", async () => {
    let resolveResponse: (value: Record<string, unknown>) => void = () => {};
    const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
      resolveResponse = resolve;
    });
    FakeProvider.responses = [responsePromise];

    const id = "test-req-running";
    const inferPromise = app.request("/v1/chat/completions", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json", "x-request-id": id },
      body: JSON.stringify({
        model: "fakee-model",
        messages: [{ role: "user", content: "please take your time" }],
      }),
    });

    await waitFor(() => FakeProvider.calls.length === 1);

    const logsRes = await app.request("/v1/admin/logs", { headers: auth });
    expect(logsRes.status).toBe(200);
    const logs = (await logsRes.json()) as {
      active_count: number;
      records: Array<{
        requestId: string;
        state: string;
        responseStatus?: number;
        elapsedMs: number;
        requestedModel: string;
        resolvedProvider?: string;
        resolvedModel?: string;
        promptTokens?: number;
        promptTokensEstimated?: boolean;
      }>;
    };
    const running = logs.records.find((record) => record.requestId === id);
    expect(logs.active_count).toBe(1);
    expect(running).toBeDefined();
    expect(running?.state).toBe("running");
    expect(running?.responseStatus).toBeUndefined();
    expect(running?.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(running?.requestedModel).toBe("fakee-model");
    expect(running?.resolvedProvider).toBe("fakee");
    expect(running?.resolvedModel).toBe("fakee-backend");
    expect(running?.promptTokens).toBeGreaterThan(0);
    expect(running?.promptTokensEstimated).toBe(true);

    resolveResponse({
      id: "c-running",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "done" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    });

    const inferRes = await inferPromise;
    expect(inferRes.status).toBe(200);

    const finalLogsRes = await app.request("/v1/admin/logs", { headers: auth });
    const finalLogs = (await finalLogsRes.json()) as {
      active_count: number;
      records: Array<{ requestId: string; state: string; responseStatus?: number; promptTokens?: number }>;
    };
    const completed = finalLogs.records.find((record) => record.requestId === id);
    expect(finalLogs.active_count).toBe(0);
    expect(completed?.state).toBe("completed");
    expect(completed?.responseStatus).toBe(200);
    expect(completed?.promptTokens).toBe(4);
  });

  test("snapshot requires auth", async () => {
    const res = await app.request("/v1/admin/events/anything");
    expect(res.status).toBe(401);
  });

  test("route traces expose masked proxy rotation metadata", async () => {
    const savedSharedProxyEnv = Object.entries(process.env).filter(([key]) =>
      key.startsWith("MODEL_PROXY_EGRESS_PROXY"),
    );
    for (const [key] of savedSharedProxyEnv) delete process.env[key];
    FakeProvider.responses = [
      new ProviderAPIError("429 first", 429, {
        provider: "fakee-proxy",
        body: "RateLimitError",
      }),
      {
        id: "c-2",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
      },
    ];
    resetKeyState("fakee-proxy");
    resetProxyState("fakee-proxy");

    try {
      const id = "test-req-proxy";
      const inferRes = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json", "x-request-id": id },
        body: JSON.stringify({
          model: "fakee-proxy-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(inferRes.status).toBe(200);

      const snapRes = await app.request(
        `/v1/admin/events/${encodeURIComponent(id)}`,
        { headers: auth },
      );
      expect(snapRes.status).toBe(200);
      const snap = (await snapRes.json()) as {
        events: Array<{
          type: string;
          egressProxyEnvVar?: string;
          egressProxyHint?: string;
        }>;
      };
      const attempts = snap.events.filter((event) => event.type === "route.attempted");
      expect(attempts).toMatchObject([
        {
          egressProxyEnvVar: "FAKEE_PROXY_EGRESS_PROXY_1",
          egressProxyHint: "proxy-one:8080",
        },
        {
          egressProxyEnvVar: "FAKEE_PROXY_EGRESS_PROXY_2",
          egressProxyHint: "proxy-two:8080",
        },
      ]);
      expect(snap.events.find((event) => event.type === "proxy.cooldown")).toMatchObject({
        egressProxyEnvVar: "FAKEE_PROXY_EGRESS_PROXY_1",
        egressProxyHint: "proxy-one:8080",
      });
    } finally {
      for (const [key] of Object.entries(process.env)) {
        if (key.startsWith("MODEL_PROXY_EGRESS_PROXY")) delete process.env[key];
      }
      for (const [key, value] of savedSharedProxyEnv) process.env[key] = value;
    }
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met before timeout");
}
