import { rmWithRetry } from "./support.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { providerConfigLoader } from "../src/config/provider-loader.ts";
import {
  buildGeminiExtraBody,
  createGeminiThoughtStreamState,
  flushGeminiThoughtStream,
  normalizeGeminiChatResponse,
  splitGeminiThoughtBlocks,
  splitGeminiThoughtStream,
} from "../src/providers/gemini-thinking.ts";
import { GeminiOpenAIProvider } from "../src/providers/gemini-provider.ts";
import { OpenAIProvider } from "../src/providers/openai-provider.ts";
import type { OpenAICallArgs, ProviderCallContext } from "../src/providers/base.ts";
import {
  chatStreamChunkToResponsesEvents,
  createResponsesStreamState,
} from "../src/format/responses.ts";

const tmpRoot = join(tmpdir(), `mp-gemini-thinking-${process.pid}-${Date.now()}`);
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  setPrimaryConfigDirForTests(tmpRoot);
  providerConfigLoader.clearCache();
  writeProviderConfig("gemini", "http://127.0.0.1:1");
  writeProviderConfig("plain-test", "http://127.0.0.1:1");
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  setPrimaryConfigDirForTests(undefined);
  providerConfigLoader.clearCache();
  rmWithRetry(tmpRoot, { recursive: true, force: true });
});

function writeProviderConfig(name: string, baseUrl: string): void {
  writeFileSync(
    join(tmpRoot, "providers", `${name}.json`),
    JSON.stringify({
      name,
      display_name: name,
      enabled: true,
      api_keys: { env_var_patterns: ["GEMINI_TEST_API_KEY"] },
      endpoints: {
        base_url: baseUrl,
        completions: "/chat/completions",
        streaming: "/chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
    }),
  );
}

function ctx(): ProviderCallContext {
  return {
    apiKey: "test-key",
    baseUrlOverride: undefined,
    timeoutSeconds: 30,
    signal: undefined,
  };
}

function baseArgs(overrides: Partial<OpenAICallArgs> = {}): OpenAICallArgs {
  return {
    model: "gemini-3.8-flash",
    messages: [{ role: "user", content: "hi" }],
    stream: false,
    ...overrides,
  };
}

async function collect(stream: AsyncGenerator<string, void, unknown>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

interface AccumulatedStream {
  reasoning: string;
  content: string;
  toolCalls: Array<Record<string, unknown>>;
  raw: string;
}

function accumulate(chunks: string[]): AccumulatedStream {
  let reasoning = "";
  let content = "";
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const frame of chunks) {
    for (const line of frame.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      const choices = parsed["choices"] as Array<Record<string, unknown>> | undefined;
      const delta = (choices?.[0]?.["delta"] ?? {}) as Record<string, unknown>;
      if (typeof delta["content"] === "string") content += delta["content"];
      if (typeof delta["reasoning_content"] === "string") {
        reasoning += delta["reasoning_content"];
      }
      if (Array.isArray(delta["tool_calls"])) {
        toolCalls.push(...(delta["tool_calls"] as Array<Record<string, unknown>>));
      }
    }
  }
  return { reasoning, content, toolCalls, raw: chunks.join("") };
}

function sseServer(frames: string[]): { origin: string; requests: Array<Record<string, unknown>> } {
  const encoder = new TextEncoder();
  const requests: Array<Record<string, unknown>> = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests.push((await req.json()) as Record<string, unknown>);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { origin: server.url.origin, requests };
}

describe("buildGeminiExtraBody: request-side thinking config", () => {
  test("maps reasoning_effort high to thinking_level high with include_thoughts", () => {
    expect(buildGeminiExtraBody({ reasoning_effort: "high" })).toEqual({
      google: {
        thinking_config: { thinking_level: "high", include_thoughts: true },
      },
    });
  });

  test("maps low-tier efforts to thinking_level low", () => {
    for (const effort of ["minimal", "low"]) {
      expect(buildGeminiExtraBody({ reasoning_effort: effort })).toEqual({
        google: {
          thinking_config: { thinking_level: "low", include_thoughts: true },
        },
      });
    }
  });

  test("falls back to reasoning.effort when reasoning_effort is absent", () => {
    expect(buildGeminiExtraBody({ reasoning: { effort: "medium" } })).toEqual({
      google: {
        thinking_config: { thinking_level: "high", include_thoughts: true },
      },
    });
  });

  test("client-supplied thinking_config wins over reasoning_effort", () => {
    const extraBody = {
      google: { thinking_config: { thinking_budget: 512, include_thoughts: false } },
    };
    expect(
      buildGeminiExtraBody({ extra_body: extraBody, reasoning_effort: "high" }),
    ).toEqual(extraBody);
  });

  test("returns undefined when there is no thinking control at all", () => {
    expect(buildGeminiExtraBody({})).toBeUndefined();
    expect(buildGeminiExtraBody({ reasoning_effort: "xhigh" })).toBeUndefined();
  });

  test("preserves unrelated extra_body keys when merging effort-derived config", () => {
    const out = buildGeminiExtraBody({
      extra_body: { google: { cached_content: "c-1" }, other: 1 },
      reasoning_effort: "high",
    });
    expect(out).toEqual({
      other: 1,
      google: {
        cached_content: "c-1",
        thinking_config: { thinking_level: "high", include_thoughts: true },
      },
    });
  });
});

describe("OpenAIProvider buildPayload: gemini thinking", () => {
  test("emits extra_body.google.thinking_config and never reasoning_effort", () => {
    const provider = new GeminiOpenAIProvider();
    const payload = provider["buildPayload"](baseArgs({ reasoning_effort: "high" }));
    expect(payload["extra_body"]).toEqual({
      google: {
        thinking_config: { thinking_level: "high", include_thoughts: true },
      },
    });
    expect("reasoning_effort" in payload).toBe(false);
    expect("reasoning" in payload).toBe(false);
  });

  test("forwards a client thinking_config verbatim and drops reasoning_effort", () => {
    const provider = new GeminiOpenAIProvider();
    const payload = provider["buildPayload"](
      baseArgs({
        reasoning_effort: "high",
        extra_body: {
          google: { thinking_config: { thinking_level: "low", include_thoughts: true } },
        },
      }),
    );
    expect(payload["extra_body"]).toEqual({
      google: { thinking_config: { thinking_level: "low", include_thoughts: true } },
    });
    expect("reasoning_effort" in payload).toBe(false);
  });

  test("non-Gemini providers keep the existing behavior (no extra_body, effort forwarded)", () => {
    const provider = new OpenAIProvider("plain-test");
    const payload = provider["buildPayload"](
      baseArgs({
        model: "some-model",
        reasoning_effort: "high",
        extra_body: { google: { thinking_config: { thinking_level: "high" } } },
      }),
    );
    expect(payload["reasoning_effort"]).toBe("high");
    expect("extra_body" in payload).toBe(false);
  });

  test("sanitized gemini messages keep extra_content (thought signatures)", () => {
    const provider = new GeminiOpenAIProvider();
    const payload = provider["buildPayload"](
      baseArgs({
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            extra_content: { google: { thought_signature: "sig-msg" } },
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "shell", arguments: "{}" },
                extra_content: { google: { thought_signature: "sig-tc" } },
              },
            ],
            reasoning_content: "internal thoughts",
          },
        ],
      }),
    );
    const messages = payload["messages"] as Array<Record<string, unknown>>;
    const assistant = messages[1]!;
    expect(assistant["extra_content"]).toEqual({
      google: { thought_signature: "sig-msg" },
    });
    const toolCalls = assistant["tool_calls"] as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.["extra_content"]).toEqual({
      google: { thought_signature: "sig-tc" },
    });
    // reasoning_content is proxy-side bookkeeping, not a Gemini request field.
    expect("reasoning_content" in assistant).toBe(false);
  });
});

describe("splitGeminiThoughtStream: tag/flag state machine", () => {
  test("splits tagged thought from trailing content within one fragment", () => {
    const state = createGeminiThoughtStreamState();
    const out = splitGeminiThoughtStream(state, "<thought>plan things</thought>Hello!", false);
    expect(out).toEqual({ reasoning: "plan things", content: "Hello!" });
  });

  test("handles tags split across fragment boundaries", () => {
    const state = createGeminiThoughtStreamState();
    const parts = ["<thou", "ght>ab", "c</thou", "ght>hi there"];
    let reasoning = "";
    let content = "";
    for (const part of parts) {
      const out = splitGeminiThoughtStream(state, part, false);
      reasoning += out.reasoning;
      content += out.content;
    }
    const flushed = flushGeminiThoughtStream(state);
    reasoning += flushed.reasoning;
    content += flushed.content;
    expect(reasoning).toBe("abc");
    expect(content).toBe("hi there");
  });

  test("flagged fragments are reasoning even without tags", () => {
    const state = createGeminiThoughtStreamState();
    const a = splitGeminiThoughtStream(state, "thinking hard", true);
    const b = splitGeminiThoughtStream(state, "Final answer", false);
    expect(a).toEqual({ reasoning: "thinking hard", content: "" });
    expect(b).toEqual({ reasoning: "", content: "Final answer" });
  });

  test("flagged thought can interleave after plain content", () => {
    const state = createGeminiThoughtStreamState();
    const a = splitGeminiThoughtStream(state, "part one.", false);
    const b = splitGeminiThoughtStream(state, "<thought>more thinking</thought>", true);
    const c = splitGeminiThoughtStream(state, "part two.", false);
    expect(a.content).toBe("part one.");
    expect(b).toEqual({ reasoning: "more thinking", content: "" });
    expect(c.content).toBe("part two.");
  });

  test("plain content that merely looks tag-ish is never eaten", () => {
    const state = createGeminiThoughtStreamState();
    const out = splitGeminiThoughtStream(state, "<thoughtful> design notes", false);
    expect(out).toEqual({ reasoning: "", content: "<thoughtful> design notes" });
  });

  test("unterminated thought flushes to reasoning, not content", () => {
    const state = createGeminiThoughtStreamState();
    const out = splitGeminiThoughtStream(state, "<thought>never closed", false);
    expect(out.reasoning).toBe("never closed");
    expect(out.content).toBe("");
    expect(flushGeminiThoughtStream(state)).toEqual({ reasoning: "", content: "" });
  });
});

describe("GeminiOpenAIProvider streaming: include_thoughts fixture", () => {
  // SSE shaped like Google's OpenAI-compat include_thoughts stream: thought
  // chunks carry <thought> tags AND extra_content.google.thought=true, the
  // answer follows as plain content, and the native tool call carries a
  // thought_signature in extra_content.
  const googleFixture = [
    'data: {"id":"g-1","object":"chat.completion.chunk","created":1725000000,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"<thought>I should list","extra_content":{"google":{"thought":true}}},"finish_reason":null}]}\n\n',
    'data: {"id":"g-1","object":"chat.completion.chunk","created":1725000000,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":" the files first.</thought>","extra_content":{"google":{"thought":true}}},"finish_reason":null}]}\n\n',
    'data: {"id":"g-1","object":"chat.completion.chunk","created":1725000000,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"Checking the directory now."},"finish_reason":null}]}\n\n',
    'data: {"id":"g-1","object":"chat.completion.chunk","created":1725000000,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_shell_1","type":"function","function":{"name":"shell","arguments":"{\\"command\\":\\"ls\\"}"},"extra_content":{"google":{"thought_signature":"sig-abc"}}}]},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ];

  test("splits thoughts into reasoning_content and keeps tool_calls native", async () => {
    const { origin, requests } = sseServer(googleFixture);
    writeProviderConfig("gemini", origin);
    providerConfigLoader.clearCache();

    const provider = new GeminiOpenAIProvider();
    const chunks = await collect(
      provider.streamOpenAI(
        baseArgs({ stream: true, reasoning_effort: "high", tools: [{ type: "function", function: { name: "shell" } }] }),
        ctx(),
      ),
    );
    const acc = accumulate(chunks);

    // Thoughts land on the reasoning channel, tags stripped.
    expect(acc.reasoning).toBe("I should list the files first.");
    // Post-thought answer stays on the content channel.
    expect(acc.content).toBe("Checking the directory now.");
    // No thought markup leaks anywhere downstream.
    expect(acc.raw).not.toContain("<thought>");
    expect(acc.raw).not.toContain("</thought>");
    // Native tool call passes through with its thought signature intact.
    const first = acc.toolCalls[0]!;
    expect(first["id"]).toBe("call_shell_1");
    expect((first["function"] as Record<string, unknown>)["name"]).toBe("shell");
    expect(first["extra_content"]).toEqual({ google: { thought_signature: "sig-abc" } });

    // Requirement 1: the thinking config is actually forwarded upstream, and
    // reasoning_effort is NOT sent alongside it (Google 400s on the pair).
    const sent = requests[0]!;
    expect(sent["extra_body"]).toEqual({
      google: { thinking_config: { thinking_level: "high", include_thoughts: true } },
    });
    expect("reasoning_effort" in sent).toBe(false);
  });

  test("OpenCode-style tool_call XML after a thought is content, not reasoning", async () => {
    const frames = [
      'data: {"id":"g-2","object":"chat.completion.chunk","created":1725000001,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"<thought>Deciding to call a tool.</thought>","extra_content":{"google":{"thought":true}}},"finish_reason":null}]}\n\n',
      'data: {"id":"g-2","object":"chat.completion.chunk","created":1725000001,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"<tool_call><function=shell><parameter=command>ls</parameter></function></tool_call>"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { origin } = sseServer(frames);
    writeProviderConfig("gemini", origin);
    providerConfigLoader.clearCache();

    const provider = new GeminiOpenAIProvider();
    const chunks = await collect(
      provider.streamOpenAI(baseArgs({ stream: true, reasoning_effort: "high" }), ctx()),
    );
    const acc = accumulate(chunks);

    expect(acc.reasoning).toBe("Deciding to call a tool.");
    // The tool XML must NOT be buried in the thought/reasoning channel — that
    // is exactly the OpenCode bug this guards against.
    expect(acc.reasoning).not.toContain("<tool_call>");
    expect(acc.content).toContain("<tool_call><function=shell>");
  });

  test("thought tags split across SSE chunks are reassembled correctly", async () => {
    const frames = [
      'data: {"id":"g-3","object":"chat.completion.chunk","created":1725000002,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"<thou"},"finish_reason":null}]}\n\n',
      'data: {"id":"g-3","object":"chat.completion.chunk","created":1725000002,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"ght>plan a"},"finish_reason":null}]}\n\n',
      'data: {"id":"g-3","object":"chat.completion.chunk","created":1725000002,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"nd verify</thou"},"finish_reason":null}]}\n\n',
      'data: {"id":"g-3","object":"chat.completion.chunk","created":1725000002,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"ght>Done."},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const { origin } = sseServer(frames);
    writeProviderConfig("gemini", origin);
    providerConfigLoader.clearCache();

    const provider = new GeminiOpenAIProvider();
    const chunks = await collect(
      provider.streamOpenAI(baseArgs({ stream: true }), ctx()),
    );
    const acc = accumulate(chunks);
    expect(acc.reasoning).toBe("plan and verify");
    expect(acc.content).toBe("Done.");
    expect(acc.raw).not.toContain("<thought>");
  });

  test("non-Gemini providers pass the same fixture through untouched", async () => {
    const { origin } = sseServer(googleFixture);
    writeProviderConfig("plain-test", origin);
    providerConfigLoader.clearCache();

    const provider = new OpenAIProvider("plain-test");
    const chunks = await collect(
      provider.streamOpenAI(baseArgs({ model: "some-model", stream: true }), ctx()),
    );
    const acc = accumulate(chunks);
    // Unchanged behavior: content stays verbatim, nothing moves to reasoning.
    expect(acc.reasoning).toBe("");
    expect(acc.content).toBe(
      "<thought>I should list the files first.</thought>Checking the directory now.",
    );
  });
});

describe("Responses bridge: gemini reasoning surfaces as reasoning events", () => {
  test("normalized gemini chunks produce reasoning_text deltas, not output_text", () => {
    const state = createResponsesStreamState("gemini-3.8-flash");
    const reasoningChunk =
      'data: {"id":"g-4","object":"chat.completion.chunk","created":1725000003,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"reasoning_content":"I should list the files."},"finish_reason":null}]}\n\n';
    const contentChunk =
      'data: {"id":"g-4","object":"chat.completion.chunk","created":1725000003,"model":"gemini-3.8-flash","choices":[{"index":0,"delta":{"content":"Listing now."},"finish_reason":null}]}\n\n';
    const first = chatStreamChunkToResponsesEvents(reasoningChunk, state).join("");
    const second = chatStreamChunkToResponsesEvents(contentChunk, state).join("");
    expect(first).toContain("response.reasoning_text.delta");
    expect(first).toContain("I should list the files.");
    expect(first).not.toContain("response.output_text.delta");
    expect(second).toContain("response.output_text.delta");
    expect(second).toContain("Listing now.");
  });
});

describe("non-streaming gemini responses", () => {
  test("splitGeminiThoughtBlocks peels leading thought blocks", () => {
    expect(splitGeminiThoughtBlocks("<thought>a</thought>\n<thought>b</thought>Answer")).toEqual({
      reasoning: "ab",
      content: "Answer",
    });
    expect(splitGeminiThoughtBlocks("no thoughts here")).toEqual({
      reasoning: "",
      content: "no thoughts here",
    });
  });

  test("normalizeGeminiChatResponse relocates thought text to reasoning_content", () => {
    const out = normalizeGeminiChatResponse({
      id: "resp-1",
      object: "chat.completion",
      created: 1725000004,
      model: "gemini-3.8-flash",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "<thought>consider options</thought>The answer is 42.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "shell", arguments: "{}" },
                extra_content: { google: { thought_signature: "sig-1" } },
              },
            ],
          },
          finish_reason: "stop",
        },
      ],
    });
    const choice = (out["choices"] as Array<Record<string, unknown>>)[0]!;
    const message = choice["message"] as Record<string, unknown>;
    expect(message["reasoning_content"]).toBe("consider options");
    expect(message["content"]).toBe("The answer is 42.");
    const toolCalls = message["tool_calls"] as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.["extra_content"]).toEqual({
      google: { thought_signature: "sig-1" },
    });
  });

  test("callOpenAI applies the split to complete responses", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: "resp-2",
          object: "chat.completion",
          created: 1725000005,
          model: "gemini-3.8-flash",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "<thought>quick check</thought>All good.",
              },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    writeProviderConfig("gemini", server.url.origin);
    providerConfigLoader.clearCache();

    const provider = new GeminiOpenAIProvider();
    const out = await provider.callOpenAI(baseArgs({ reasoning_effort: "low" }), ctx());
    const choice = (out["choices"] as Array<Record<string, unknown>>)[0]!;
    const message = choice["message"] as Record<string, unknown>;
    expect(message["reasoning_content"]).toBe("quick check");
    expect(message["content"]).toBe("All good.");
  });
});
