import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { OpenAIProvider } from "../src/providers/openai-provider.ts";

const tmpRoot = join(tmpdir(), `mp-openai-stream-${process.pid}-${Date.now()}`);
let savedSearchPaths: string[] | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  const loader = providerConfigLoader as unknown as { searchPaths: string[] };
  savedSearchPaths = [...loader.searchPaths];
  loader.searchPaths = [tmpRoot];
  providerConfigLoader.clearCache();
});

afterEach(() => {
  server?.stop(true);
  server = undefined;

  const loader = providerConfigLoader as unknown as { searchPaths: string[] };
  if (savedSearchPaths !== undefined) {
    loader.searchPaths = savedSearchPaths;
    savedSearchPaths = undefined;
  }
  providerConfigLoader.clearCache();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("OpenAIProvider streaming termination", () => {
  test("treats data [DONE] as terminal even when the upstream socket stays open", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            // Deliberately keep the stream open. Some compatible upstreams send
            // the terminal frame but do not promptly close the response body.
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    writeProviderConfig(server.url.origin);

    const provider = new OpenAIProvider("stream-test");
    const abort = new AbortController();
    const streamPromise = collect(
      provider.streamOpenAI(
        {
          model: "stream-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        {
          apiKey: "test-key",
          baseUrlOverride: undefined,
          timeoutSeconds: 30,
          signal: abort.signal,
        },
      ),
    );

    const result = await Promise.race([
      streamPromise,
      new Promise<"timeout">((resolve) => setTimeout(resolve, 250, "timeout")),
    ]);

    if (result === "timeout") {
      abort.abort();
      await streamPromise.catch(() => undefined);
    }

    expect(result).not.toBe("timeout");
    if (result !== "timeout") {
      expect(result).toHaveLength(2);
      const payload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
      expect(payload["id"]).toBe("chunk-1");
      expect(payload["object"]).toBe("chat.completion.chunk");
      expect(payload["model"]).toBe("stream-model");
      expect(result[1]).toBe("data: [DONE]\n\n");
    }
  });

  test("normalizes malformed reasoning stream chunks", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"id":null,"choices":[{"index":null,"delta":{"content":null,"reasoning_content":"thinking","tool_calls":[{"id":null,"type":"function","function":{"name":"noop","arguments":""}}]}}]}\n\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    writeProviderConfig(server.url.origin);

    const provider = new OpenAIProvider("stream-test");
    const result = await collect(
      provider.streamOpenAI(
        {
          model: "stream-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        {
          apiKey: "test-key",
          baseUrlOverride: undefined,
          timeoutSeconds: 30,
          signal: undefined,
        },
      ),
    );

    expect(result).toHaveLength(2);
    const payload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
    expect(typeof payload["id"]).toBe("string");
    expect(payload["object"]).toBe("chat.completion.chunk");
    expect(typeof payload["created"]).toBe("number");
    expect(payload["model"]).toBe("stream-model");
    const choices = payload["choices"] as Array<Record<string, unknown>>;
    expect(choices[0]?.["index"]).toBe(0);
    const delta = choices[0]?.["delta"] as Record<string, unknown>;
    expect(delta["content"]).toBe("");
    expect(delta["reasoning_content"]).toBe("thinking");
    const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>>;
    expect(toolCalls[0]?.["id"]).toBe("call_0");
    expect(toolCalls[0]?.["index"]).toBe(0);
    expect(toolCalls[0]?.["type"]).toBe("function");
    const fn = toolCalls[0]?.["function"] as Record<string, unknown>;
    expect(fn["name"]).toBe("noop");
    expect(fn["arguments"]).toBe("");
    expect(result[1]).toBe("data: [DONE]\n\n");
  });

  test("normalizes partial edit tool-call stream deltas", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"content":null,"tool_calls":[{"index":null,"id":null,"function":{"name":42,"arguments":{"file":"a.ts"}}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"old\\""}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"x\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    writeProviderConfig(server.url.origin);

    const provider = new OpenAIProvider("stream-test");
    const result = await collect(
      provider.streamOpenAI(
        {
          model: "stream-model",
          messages: [{ role: "user", content: "edit a file" }],
          stream: true,
        },
        {
          apiKey: "test-key",
          baseUrlOverride: undefined,
          timeoutSeconds: 30,
          signal: undefined,
        },
      ),
    );

    expect(result).toHaveLength(4);
    for (const chunk of result.slice(0, 3)) {
      const payload = JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>;
      const choices = payload["choices"] as Array<Record<string, unknown>>;
      const delta = choices[0]?.["delta"] as Record<string, unknown>;
      if ("content" in delta) expect(delta["content"]).toBe("");
      const toolCalls = delta["tool_calls"] as Array<Record<string, unknown>>;
      const toolCall = toolCalls[0]!;
      expect(toolCall["index"]).toBe(0);
      expect(toolCall["id"]).toBe("call_0");
      expect(toolCall["type"]).toBe("function");
      const fn = toolCall["function"] as Record<string, unknown>;
      expect(typeof fn["name"]).toBe("string");
      expect(typeof fn["arguments"]).toBe("string");
    }

    const firstPayload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
    const firstChoices = firstPayload["choices"] as Array<Record<string, unknown>>;
    const firstDelta = firstChoices[0]?.["delta"] as Record<string, unknown>;
    const firstToolCall = (firstDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    const firstFn = firstToolCall["function"] as Record<string, unknown>;
    expect(firstFn["name"]).toBe("");
    expect(firstFn["arguments"]).toBe('{"file":"a.ts"}');
    expect(result[3]).toBe("data: [DONE]\n\n");
  });

  test("keeps streamed tool-call ids stable across edit argument chunks", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"provider-edit-call","type":"function","function":{"name":"edit_file","arguments":"{\\"path\\""}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"src/a.ts\\","}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"provider-late-different-id","function":{"arguments":"\\"old_text\\":\\"a\\",\\"new_text\\":\\"b\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    writeProviderConfig(server.url.origin);

    const provider = new OpenAIProvider("stream-test");
    const result = await collect(
      provider.streamOpenAI(
        {
          model: "stream-model",
          messages: [{ role: "user", content: "edit a file" }],
          stream: true,
        },
        {
          apiKey: "test-key",
          baseUrlOverride: undefined,
          timeoutSeconds: 30,
          signal: undefined,
        },
      ),
    );

    expect(result).toHaveLength(4);
    for (const chunk of result.slice(0, 3)) {
      const payload = JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>;
      const choices = payload["choices"] as Array<Record<string, unknown>>;
      const delta = choices[0]?.["delta"] as Record<string, unknown>;
      const toolCall = ((delta["tool_calls"] as Array<Record<string, unknown>>) ?? [])[0]!;
      expect(toolCall["id"]).toBe("provider-edit-call");
      expect(toolCall["index"]).toBe(0);
      expect(toolCall["type"]).toBe("function");
      const fn = toolCall["function"] as Record<string, unknown>;
      expect(typeof fn["name"]).toBe("string");
      expect(typeof fn["arguments"]).toBe("string");
    }

    const lastPayload = JSON.parse(result[2]!.slice("data: ".length)) as Record<string, unknown>;
    const lastChoices = lastPayload["choices"] as Array<Record<string, unknown>>;
    const lastDelta = lastChoices[0]?.["delta"] as Record<string, unknown>;
    const lastToolCall = (lastDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    expect(lastToolCall["provider_id"]).toBe("provider-late-different-id");
  });

  test("does not expose partial tool-call chunks when upstream aborts mid-edit", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"provider-edit-call","type":"function","function":{"name":"edit","arguments":"{\\"filePath\\""}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"/tmp/a.ts\\","}}]}}]}\n\n',
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    writeProviderConfig(server.url.origin);

    const provider = new OpenAIProvider("stream-test");
    const emitted: string[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of provider.streamOpenAI(
        {
          model: "stream-model",
          messages: [{ role: "user", content: "edit a file" }],
          stream: true,
        },
        {
          apiKey: "test-key",
          baseUrlOverride: undefined,
          timeoutSeconds: 30,
          signal: undefined,
          bufferPartialToolCalls: true,
        },
      )) {
        emitted.push(chunk);
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect(emitted).toEqual([]);
  });

  test("normalizes null reasoning fields after tool-call continuations", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"reasoning":null,"reasoning_content":null,"content":"edit complete"}}]}\n\n',
              ),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    writeProviderConfig(server.url.origin);

    const provider = new OpenAIProvider("stream-test");
    const result = await collect(
      provider.streamOpenAI(
        {
          model: "stream-model",
          messages: [
            { role: "user", content: "edit" },
            {
              role: "assistant",
              content: "",
              tool_calls: [
                {
                  id: "call_0",
                  type: "function",
                  function: { name: "edit_file", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_0", content: "ok" },
          ],
          stream: true,
        },
        {
          apiKey: "test-key",
          baseUrlOverride: undefined,
          timeoutSeconds: 30,
          signal: undefined,
        },
      ),
    );

    expect(result).toHaveLength(2);
    const payload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
    const choices = payload["choices"] as Array<Record<string, unknown>>;
    const delta = choices[0]?.["delta"] as Record<string, unknown>;
    expect(delta["content"]).toBe("edit complete");
    expect(delta["reasoning"]).toBe("");
    expect(delta["reasoning_content"]).toBe("");
  });

  test("preserves reasoning fields when synthesizing SSE from JSON", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          id: "json-response",
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "",
                reasoning_content: "json thinking",
              },
            },
          ],
        });
      },
    });

    writeProviderConfig(server.url.origin);

    const provider = new OpenAIProvider("stream-test");
    const result = await collect(
      provider.streamOpenAI(
        {
          model: "stream-model",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        },
        {
          apiKey: "test-key",
          baseUrlOverride: undefined,
          timeoutSeconds: 30,
          signal: undefined,
        },
      ),
    );

    expect(result).toHaveLength(2);
    const payload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
    const choices = payload["choices"] as Array<Record<string, unknown>>;
    const delta = choices[0]?.["delta"] as Record<string, unknown>;
    expect(delta["content"]).toBe("");
    expect(delta["reasoning_content"]).toBe("json thinking");
    expect(result[1]).toBe("data: [DONE]\n\n");
  });
});

async function collect(stream: AsyncGenerator<string, void, unknown>): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function writeProviderConfig(baseUrl: string): void {
  writeFileSync(
    join(tmpRoot, "providers", "stream-test.json"),
    JSON.stringify({
      name: "stream-test",
      display_name: "Stream Test",
      enabled: true,
      api_keys: { env_var_patterns: ["STREAM_TEST_API_KEY"] },
      endpoints: {
        base_url: baseUrl,
        completions: "/v1/chat/completions",
        streaming: "/v1/chat/completions",
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
