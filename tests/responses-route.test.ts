import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.ts";
import { providerRegistry } from "../src/providers/registry.ts";
import type { BaseProvider, ProviderCallContext, ResponsesCallArgs } from "../src/providers/base.ts";
import type { ProviderConfig } from "../shared/schemas/provider.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { resetGlobalResponseStoreForTests } from "../src/format/response-store.ts";
import { ProviderTimeoutError } from "../src/providers/errors.ts";

const providerConfig = {} as ProviderConfig;
const originalClientKey = process.env.CLIENT_API_KEY;
const root = mkdtempSync(join(tmpdir(), "mp-responses-route-"));

class RouteResponsesFake implements BaseProvider {
  readonly providerName = "route-responses-fake";
  readonly config = providerConfig;
  readonly wireProtocol = "responses" as const;

  async callResponses(args: ResponsesCallArgs, _ctx: ProviderCallContext) {
    const input = args.input;
    if (typeof input === "string" && input.includes("call lookup")) {
      return {
        id: "resp_tool_route",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: args.model,
        output: [{ type: "function_call", id: "fc_route", call_id: "call_route", name: "lookup", arguments: "{\"city\":\"Tokyo\"}", status: "completed" }],
      };
    }
    if (Array.isArray(input) && input.some((item) => typeof item === "object" && item !== null && (item as Record<string, unknown>)["type"] === "function_call_output")) {
      return {
        id: "resp_tool_final_route",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: args.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "lookup complete" }] }],
        output_text: "lookup complete",
      };
    }
    return {
      id: "resp_route",
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: args.model,
      output: [{
        type: "message",
        id: "msg_route",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: "route answer", annotations: [] }],
      }],
      usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      output_text: "route answer",
    };
  }

  async *streamResponses(args: ResponsesCallArgs, _ctx: ProviderCallContext) {
    yield `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_stream_route", status: "in_progress", model: args.model } })}\n\n`;
    yield 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"stream route"}\n\n';
    yield `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_stream_route",
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status: "completed",
        model: args.model,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "stream route" }] }],
        output_text: "stream route",
        usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      },
    })}\n\n`;
  }
}

class FailingResponsesFake implements BaseProvider {
  readonly providerName = "failing-responses-fake";
  readonly config = providerConfig;
  readonly wireProtocol = "responses" as const;

  async callResponses(): Promise<Record<string, unknown>> {
    throw new ProviderTimeoutError("intentional Responses route timeout", 1);
  }

  async *streamResponses(): AsyncGenerator<string, void, unknown> {
    throw new ProviderTimeoutError("intentional Responses stream timeout", 1);
  }
}

describe("Responses HTTP route", () => {
  const app = createApp();

  beforeAll(() => {
    process.env.CLIENT_API_KEY = "responses-route-test-key";
    setStorageRootForTests(join(root, ".storage"));
    closeOperationalDbForTests();
    mkdirSync(join(root, "models"), { recursive: true });
    mkdirSync(join(root, "providers"), { recursive: true });
    writeFileSync(join(root, "providers", "route-responses-fake.json"), JSON.stringify({
      name: "route-responses-fake",
      api_keys: { env_var_patterns: [], default_value: "public" },
      endpoints: {
        base_url: "http://127.0.0.1:9999",
        completions: "/responses",
        streaming: "/responses",
        compatible_format: "responses",
      },
      authentication: { type: "none" },
    }));
    writeFileSync(join(root, "providers", "failing-responses-fake.json"), JSON.stringify({
      name: "failing-responses-fake",
      api_keys: { env_var_patterns: [], default_value: "public" },
      endpoints: {
        base_url: "http://127.0.0.1:9998",
        completions: "/responses",
        compatible_format: "responses",
      },
      authentication: { type: "none" },
    }));
    writeFileSync(join(root, "models", "route-responses.json"), JSON.stringify({
      logical_name: "route-responses",
      model_routings: [{ provider: "route-responses-fake", model: "glm-5.2", wire_protocol: "responses", auth_mode: "public" }],
    }));
    writeFileSync(join(root, "models", "route-responses-fallback.json"), JSON.stringify({
      logical_name: "route-responses-fallback",
      model_routings: [{ provider: "failing-responses-fake", model: "glm-5.2", wire_protocol: "responses", auth_mode: "public" }],
      fallback_model_routings: ["route-responses"],
    }));
    writeFileSync(join(root, "models", "route-responses-chat.json"), JSON.stringify({
      logical_name: "route-responses-chat",
      model_routings: [{ provider: "route-responses-fake", model: "glm-5.2", wire_protocol: "openai", auth_mode: "public" }],
    }));
    (modelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [root];
    (providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [root];
    providerRegistry.registerProvider("route-responses-fake", () => new RouteResponsesFake());
    providerRegistry.registerProvider("failing-responses-fake", () => new FailingResponsesFake());
  });

  beforeEach(() => {
    resetGlobalResponseStoreForTests().clear();
  });

  afterAll(() => {
    providerRegistry.unregisterProvider("route-responses-fake");
    providerRegistry.unregisterProvider("failing-responses-fake");
    closeOperationalDbForTests();
    setStorageRootForTests(undefined);
    rmSync(root, { recursive: true, force: true });
    if (originalClientKey === undefined) delete process.env.CLIENT_API_KEY;
    else process.env.CLIENT_API_KEY = originalClientKey;
  });

  function headers(): Record<string, string> {
    return {
      authorization: "Bearer responses-route-test-key",
      "content-type": "application/json",
    };
  }

  test("creates, retrieves, chains, and deletes a persisted response", async () => {
    const first = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "route-responses", input: "remember this" }),
    });
    expect(first.status).toBe(200);
    const firstJson = await first.json() as Record<string, unknown>;
    expect(firstJson.object).toBe("response");

    const id = firstJson.id as string;
    const retrieved = await app.request(`http://localhost/v1/responses/${id}`, {
      headers: headers(),
    });
    expect(retrieved.status).toBe(200);
    expect((await retrieved.json() as Record<string, unknown>).id).toBe(id);

    const continued = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "route-responses", previous_response_id: id, input: "continue" }),
    });
    expect(continued.status).toBe(200);

    const deleted = await app.request(`http://localhost/v1/responses/${id}`, {
      method: "DELETE",
      headers: headers(),
    });
    expect(deleted.status).toBe(200);
    expect((await deleted.json() as Record<string, unknown>).deleted).toBe(true);
    expect((await app.request(`http://localhost/v1/responses/${id}`, { headers: headers() })).status).toBe(404);
  });

  test("streams native Responses events and persists the completed response", async () => {
    const result = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "route-responses", input: "stream", stream: true }),
    });
    expect(result.status).toBe(200);
    const text = await result.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");

    const retrieved = await app.request("http://localhost/v1/responses/resp_stream_route", {
      headers: headers(),
    });
    expect(retrieved.status).toBe(200);
    expect((await retrieved.json() as Record<string, unknown>).output_text).toBe("stream route");
  });

  test("supports an HTTP function-call tool loop with durable input items", async () => {
    const first = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "route-responses",
        input: "call lookup for Tokyo",
        tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
      }),
    });
    expect(first.status).toBe(200);
    const firstJson = await first.json() as Record<string, unknown>;
    const firstOutput = firstJson.output as Array<Record<string, unknown>>;
    expect(firstOutput[0]?.["type"]).toBe("function_call");

    const second = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "route-responses",
        previous_response_id: firstJson.id,
        input: [{ type: "function_call_output", call_id: "call_route", output: "Tokyo is sunny" }],
      }),
    });
    expect(second.status).toBe(200);
    expect((await second.json() as Record<string, unknown>).output_text).toBe("lookup complete");
  });

  test("falls back across native Responses routes", async () => {
    const response = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "route-responses-fallback", input: "fallback" }),
    });
    expect(response.status).toBe(200);
    expect((await response.json() as Record<string, unknown>).output_text).toBe("route answer");
  });

  test("rejects native-only features instead of silently dropping them", async () => {
    const response = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "route-responses-chat",
        input: "search",
        tools: [{ type: "web_search_preview" }],
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json() as Record<string, unknown>).error).toMatchObject({ type: "invalid_request_error" });
  });

  test("honors store=false and reports missing previous responses", async () => {
    const notFound = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "route-responses", previous_response_id: "resp_missing", input: "continue" }),
    });
    expect(notFound.status).toBe(400);

    const transient = await app.request("http://localhost/v1/responses", {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "route-responses", input: "transient", store: false }),
    });
    expect(transient.status).toBe(200);
    const transientJson = await transient.json() as Record<string, unknown>;
    const retrieved = await app.request(`http://localhost/v1/responses/${transientJson.id as string}`, { headers: headers() });
    expect(retrieved.status).toBe(404);
  });
});
