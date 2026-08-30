import { rmWithRetry } from "./support.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { OpenAIProvider } from "../src/providers/openai-provider.ts";

const servers: Array<{ stop(): void }> = [];
const roots: string[] = [];

afterEach(() => {
  setPrimaryConfigDirForTests(undefined);
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmWithRetry(root, { recursive: true, force: true });
});

describe("native Responses provider transport", () => {
  test("posts to the configured Responses endpoint and preserves SSE event framing", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = await request.json() as Record<string, unknown>;
        requests.push(body);
        if (body["stream"] === true) {
          return new Response(
            'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_transport"}}\n\n' +
            'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_transport","status":"completed","output":[]}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return Response.json({
          id: "resp_transport",
          object: "response",
          status: "completed",
          model: body["model"],
          output: [],
        });
      },
    });
    servers.push(server);

    const root = mkdtempSync(join(tmpdir(), "mp-responses-transport-"));
    roots.push(root);
    mkdirSync(join(root, "providers"), { recursive: true });
    writeFileSync(join(root, "providers", "transport-fake.json"), JSON.stringify({
      name: "transport-fake",
      api_keys: { env_var_patterns: [], default_value: "test" },
      endpoints: {
        base_url: `http://127.0.0.1:${server.port}`,
        completions: "/chat/completions",
        streaming: "/chat/completions",
        responses: "/responses",
        responses_streaming: "/responses",
        compatible_format: "openai",
      },
      authentication: { type: "none" },
    }));
    setPrimaryConfigDirForTests(root);

    const provider = new OpenAIProvider("transport-fake");
    const ctx = {
      apiKey: "test",
      baseUrlOverride: undefined,
      timeoutSeconds: 5,
      signal: undefined,
    };
    const response = await provider.callResponses({ model: "glm-5.2", input: "hello" }, ctx);
    expect(response.object).toBe("response");
    const chunks: string[] = [];
    for await (const chunk of provider.streamResponses({ model: "glm-5.2", input: "hello" }, ctx)) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toContain("event: response.created\ndata:");
    expect(chunks[0]).toEndWith("\n\n");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ model: "glm-5.2", input: "hello", stream: false });
    expect(requests[1]).toMatchObject({ model: "glm-5.2", input: "hello", stream: true });
  });
});
