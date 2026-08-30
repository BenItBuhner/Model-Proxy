import { rmWithRetry } from "./support.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { OpenAIProvider } from "../src/providers/openai-provider.ts";
import type { ProviderCallContext } from "../src/providers/base.ts";

const tmpRoot = join(tmpdir(), `mp-openai-stream-${process.pid}-${Date.now()}`);
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  setPrimaryConfigDirForTests(tmpRoot);
  providerConfigLoader.clearCache();
});

afterEach(() => {
  server?.stop(true);
  server = undefined;

  setPrimaryConfigDirForTests(undefined);
  providerConfigLoader.clearCache();
  rmWithRetry(tmpRoot, { recursive: true, force: true });
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
    // Canonical shape: empty/null content spam is dropped from tool-call deltas.
    expect("content" in delta).toBe(false);
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
    // Canonical OpenAI shape: only the FIRST fragment of a logical tool call
    // carries id/type/name; continuations carry only index + arguments.
    const firstPayload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
    const firstChoices = firstPayload["choices"] as Array<Record<string, unknown>>;
    const firstDelta = firstChoices[0]?.["delta"] as Record<string, unknown>;
    // Canonical shape: empty/null content spam is dropped from tool-call deltas.
    expect("content" in firstDelta).toBe(false);
    const firstToolCall = (firstDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    expect(firstToolCall["index"]).toBe(0);
    expect(firstToolCall["id"]).toBe("call_0");
    expect(firstToolCall["type"]).toBe("function");
    const firstFn = firstToolCall["function"] as Record<string, unknown>;
    expect(firstFn["name"]).toBe("");
    expect(firstFn["arguments"]).toBe('{"file":"a.ts"}');

    for (const chunk of result.slice(1, 3)) {
      const payload = JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>;
      const choices = payload["choices"] as Array<Record<string, unknown>>;
      const delta = choices[0]?.["delta"] as Record<string, unknown>;
      const toolCall = (delta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
      expect(toolCall["index"]).toBe(0);
      expect("id" in toolCall).toBe(false);
      const fn = toolCall["function"] as Record<string, unknown>;
      expect("name" in fn).toBe(false);
      expect(typeof fn["arguments"]).toBe("string");
    }
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
    const firstPayload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
    const firstChoices = firstPayload["choices"] as Array<Record<string, unknown>>;
    const firstDelta = firstChoices[0]?.["delta"] as Record<string, unknown>;
    const firstToolCall = (firstDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    expect(firstToolCall["id"]).toBe("provider-edit-call");
    expect(firstToolCall["index"]).toBe(0);
    expect(firstToolCall["type"]).toBe("function");
    expect((firstToolCall["function"] as Record<string, unknown>)["name"]).toBe("edit_file");

    // Continuations — including the one with a flaky late id and no name —
    // merge into the same call and are emitted bare (index + arguments only).
    let mergedArgs = (firstToolCall["function"] as Record<string, unknown>)["arguments"] as string;
    for (const chunk of result.slice(1, 3)) {
      const payload = JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>;
      const choices = payload["choices"] as Array<Record<string, unknown>>;
      const delta = choices[0]?.["delta"] as Record<string, unknown>;
      const toolCall = (delta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
      expect(toolCall["index"]).toBe(0);
      expect("id" in toolCall).toBe(false);
      const fn = toolCall["function"] as Record<string, unknown>;
      expect("name" in fn).toBe(false);
      mergedArgs += fn["arguments"] as string;
    }
    expect(JSON.parse(mergedArgs)).toEqual({
      path: "src/a.ts",
      old_text: "a",
      new_text: "b",
    });
  });

  test("keeps distinct sequential tool calls separate when upstream reuses index 0", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // First tool call: id + name, args split over two chunks.
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_write","type":"function","function":{"name":"Write","arguments":"{\\"path\\":\\"plan.md\\","}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"contents\\":\\"x\\"}"}}]}}]}\n\n',
              ),
            );
            // Second, DISTINCT tool call: upstream reuses index 0 but sends a
            // fresh id and a function name.
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_task","type":"function","function":{"name":"Task","arguments":"{\\"prompt\\""}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"go\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
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
          messages: [{ role: "user", content: "write a plan then spawn a task" }],
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

    expect(result).toHaveLength(5);

    // Accumulate like an OpenAI-compatible client: key on tool-call index,
    // concatenate argument fragments.
    const accumulated = new Map<number, { id?: string; name?: string; args: string }>();
    for (const chunk of result.slice(0, 4)) {
      const payload = JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>;
      const choices = payload["choices"] as Array<Record<string, unknown>>;
      const delta = choices[0]?.["delta"] as Record<string, unknown>;
      for (const rawCall of (delta["tool_calls"] as Array<Record<string, unknown>>) ?? []) {
        const idx = rawCall["index"] as number;
        const entry = accumulated.get(idx) ?? { args: "" };
        if (typeof rawCall["id"] === "string") entry.id ??= rawCall["id"];
        const fn = rawCall["function"] as Record<string, unknown>;
        if (typeof fn["name"] === "string" && fn["name"].length > 0) entry.name ??= fn["name"];
        if (typeof fn["arguments"] === "string") entry.args += fn["arguments"];
        accumulated.set(idx, entry);
      }
    }

    // Two distinct calls must land in two distinct accumulation slots, each
    // with independently parseable JSON arguments.
    expect(accumulated.size).toBe(2);
    const calls = [...accumulated.values()];
    const write = calls.find((c) => c.name === "Write");
    const task = calls.find((c) => c.name === "Task");
    expect(write).toBeDefined();
    expect(task).toBeDefined();
    expect(write!.id).toBe("call_write");
    expect(task!.id).toBe("call_task");
    expect(JSON.parse(write!.args)).toEqual({ path: "plan.md", contents: "x" });
    expect(JSON.parse(task!.args)).toEqual({ prompt: "go" });
  });

  test("keeps distinct sequential tool calls separate when upstream omits index entirely", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_a","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_b","type":"function","function":{"name":"Read","arguments":"{\\"path\\":\\"b.ts\\"}"}}]}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
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
          messages: [{ role: "user", content: "read two files" }],
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

    const firstPayload = JSON.parse(result[0]!.slice("data: ".length)) as Record<string, unknown>;
    const secondPayload = JSON.parse(result[1]!.slice("data: ".length)) as Record<string, unknown>;
    const firstCall = (((firstPayload["choices"] as Array<Record<string, unknown>>)[0]!["delta"] as Record<string, unknown>)["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    const secondCall = (((secondPayload["choices"] as Array<Record<string, unknown>>)[0]!["delta"] as Record<string, unknown>)["tool_calls"] as Array<Record<string, unknown>>)[0]!;

    expect(firstCall["id"]).toBe("call_a");
    expect(secondCall["id"]).toBe("call_b");
    expect(firstCall["index"]).not.toBe(secondCall["index"]);
  });

  test("canonicalizes nahcrof-shaped streams: per-chunk ids, repeated call ids, null tool_calls", async () => {
    const encoder = new TextEncoder();
    server = Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Real nahcrof quirks: fresh top-level id every chunk, tool_calls:null
            // on non-tool deltas, full call id + empty name on every fragment.
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-1.111","object":"chat.completion.chunk","created":100,"model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":null}}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-2.222","object":"chat.completion.chunk","created":101,"model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"index":0,"id":"call_00_abc","type":"function","function":{"name":"write_file","arguments":"{\\"path\\""}}]},"logprobs":null}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-3.333","object":"chat.completion.chunk","created":102,"model":"glm-5.2","choices":[{"index":0,"delta":{"role":"assistant","content":"","tool_calls":[{"index":0,"id":"call_00_abc","function":{"arguments":":\\"a.kt\\"}","name":""},"type":"function"}]},"logprobs":null}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"id":"chatcmpl-4.444","object":"chat.completion.chunk","created":103,"model":"glm-5.2","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
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
          messages: [{ role: "user", content: "write a file" }],
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

    expect(result).toHaveLength(5);
    const payloads = result
      .slice(0, 4)
      .map((chunk) => JSON.parse(chunk.slice("data: ".length)) as Record<string, unknown>);

    // One completion id and one created timestamp across the whole stream.
    const ids = new Set(payloads.map((p) => p["id"]));
    const createds = new Set(payloads.map((p) => p["created"]));
    expect(ids.size).toBe(1);
    expect(ids.has("chatcmpl-1.111")).toBe(true);
    expect(createds.size).toBe(1);

    // Every choice carries an explicit finish_reason key (null until terminal).
    for (const [i, payload] of payloads.entries()) {
      const choice = (payload["choices"] as Array<Record<string, unknown>>)[0]!;
      expect("finish_reason" in choice).toBe(true);
      expect(choice["finish_reason"]).toBe(i === 3 ? "tool_calls" : null);
    }

    // tool_calls:null keys are gone; the first delta keeps role + content "".
    const firstDelta = ((payloads[0]!["choices"] as Array<Record<string, unknown>>)[0]![
      "delta"
    ]) as Record<string, unknown>;
    expect("tool_calls" in firstDelta).toBe(false);
    expect(firstDelta["role"]).toBe("assistant");

    // First fragment carries id/type/name; repeated role/content spam is gone.
    const startDelta = ((payloads[1]!["choices"] as Array<Record<string, unknown>>)[0]![
      "delta"
    ]) as Record<string, unknown>;
    expect("role" in startDelta).toBe(false);
    expect("content" in startDelta).toBe(false);
    const startCall = (startDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    expect(startCall["id"]).toBe("call_00_abc");
    expect((startCall["function"] as Record<string, unknown>)["name"]).toBe("write_file");

    const contDelta = ((payloads[2]!["choices"] as Array<Record<string, unknown>>)[0]![
      "delta"
    ]) as Record<string, unknown>;
    expect("role" in contDelta).toBe(false);
    expect("content" in contDelta).toBe(false);
    const contCall = (contDelta["tool_calls"] as Array<Record<string, unknown>>)[0]!;
    expect("id" in contCall).toBe(false);
    const contFn = contCall["function"] as Record<string, unknown>;
    expect("name" in contFn).toBe(false);

    // Accumulated arguments parse.
    const args =
      ((startCall["function"] as Record<string, unknown>)["arguments"] as string) +
      (contFn["arguments"] as string);
    expect(JSON.parse(args)).toEqual({ path: "a.kt" });
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

describe("OpenAIProvider stream smoothing", () => {
  const SENTENCE =
    "Streaming feels much smoother when bursts are re-chunked into steady pieces. ";

  function burstServer(): ReturnType<typeof Bun.serve> {
    const encoder = new TextEncoder();
    return Bun.serve({
      port: 0,
      fetch() {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'data: {"id":"c1","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: "c2",
                  object: "chat.completion.chunk",
                  model: "m",
                  choices: [{ index: 0, delta: { content: SENTENCE }, finish_reason: null }],
                })}\n\n`,
              ),
            );
            controller.enqueue(
              encoder.encode(
                'data: {"id":"c3","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
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
  }

  function makeCtx(smooth: boolean): ProviderCallContext {
    return {
      apiKey: "test-key",
      baseUrlOverride: undefined,
      timeoutSeconds: 30,
      signal: new AbortController().signal,
      smoothStreaming: smooth,
    };
  }

  function deltaOf(chunk: Record<string, unknown>): Record<string, unknown> {
    return ((chunk["choices"] as Array<Record<string, unknown>>)[0]!["delta"] ??
      {}) as Record<string, unknown>;
  }

  test("re-chunks content bursts into paced pieces with order preserved", async () => {
    server = burstServer();
    writeProviderConfig(server.url.origin);
    const provider = new OpenAIProvider("stream-test");
    const chunks = await collect(
      provider.streamOpenAI(
        { model: "stream-model", messages: [{ role: "user", content: "hi" }], stream: true },
        makeCtx(true),
      ),
    );
    expect(chunks[chunks.length - 1]).toBe("data: [DONE]\n\n");
    const parsed = chunks
      .slice(0, -1)
      .map((c) => JSON.parse(c.slice("data: ".length)) as Record<string, unknown>);
    const finishFrame = parsed[parsed.length - 1]!;
    expect(finishFrame["choices"] && (finishFrame["choices"] as Array<Record<string, unknown>>)[0]!["finish_reason"]).toBe("stop");
    const contentFrames = parsed.slice(0, -1);
    expect(contentFrames.length).toBeGreaterThan(2);
    expect(contentFrames.map((c) => deltaOf(c)["content"]).join("")).toBe(SENTENCE);
    expect(deltaOf(contentFrames[0]!)["role"]).toBe("assistant");
  });

  test("stays 1:1 passthrough when smoothing is off", async () => {
    server = burstServer();
    writeProviderConfig(server.url.origin);
    const provider = new OpenAIProvider("stream-test");
    const chunks = await collect(
      provider.streamOpenAI(
        { model: "stream-model", messages: [{ role: "user", content: "hi" }], stream: true },
        makeCtx(false),
      ),
    );
    expect(chunks).toHaveLength(4);
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
