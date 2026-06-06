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
      expect(result).toEqual([
        'data: {"id":"chunk-1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
        "data: [DONE]\n\n",
      ]);
    }
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
