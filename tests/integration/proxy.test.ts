/**
 * Full integration test suite - tests all routes through the proxy with fake upstream servers.
 * Uses a single shared test environment to avoid config conflicts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { startFakeOpenAI } from "../helpers/fake-servers.ts";
import { addTestProvider, addTestModel, resetTestState, initTestEnv, cleanupTestEnv } from "../helpers/test-setup.ts";
import { createApp } from "../../src/app.ts";
import type { Server } from "bun";

const GOOD_KEY = "test-good-key-123";
const CLIENT_KEY = "proxy-test-client-key";

let goodServer: Server;
let badServer: Server;
let proxyServer: Server;

beforeAll(() => {
  // Set client API key
  process.env.CLIENT_API_KEY = CLIENT_KEY;

  // Start fake servers
  goodServer = startFakeOpenAI({ validApiKeys: [GOOD_KEY], responseContent: "Test response OK" });
  badServer = startFakeOpenAI({ errorStatus: 500 });

  const goodUrl = `http://localhost:${goodServer.port}`;
  const badUrl = `http://localhost:${badServer.port}`;

  // Set up test environment
  initTestEnv();

  // Add providers
  addTestProvider("goodprov", goodUrl);
  addTestProvider("badprov", badUrl, {
    errorHandling: { "500": { action: "model_key_failure" } },
  });

  // Set API keys
  process.env.GOODPROV_API_KEY = GOOD_KEY;
  process.env.BADPROV_API_KEY = "bad-key-doesnt-matter";

  // Add models
  addTestModel("test-model", [{ provider: "goodprov", model: "test-model" }]);
  addTestModel("fallback-model", [
    { provider: "badprov", model: "fallback-model" },
    { provider: "goodprov", model: "fallback-model" },
  ]);

  // Start proxy
  const app = createApp();
  proxyServer = Bun.serve({ port: 0, fetch: app.fetch });
});

beforeEach(() => {
  resetTestState();
  process.env.GOODPROV_API_KEY = GOOD_KEY;
  process.env.BADPROV_API_KEY = "bad-key-doesnt-matter";
});

afterAll(() => {
  goodServer.stop();
  badServer.stop();
  proxyServer.stop();
  cleanupTestEnv();
  delete process.env.CLIENT_API_KEY;
  delete process.env.GOODPROV_API_KEY;
  delete process.env.BADPROV_API_KEY;
});

const base = () => `http://localhost:${proxyServer.port}`;
const headers = () => ({
  "Authorization": `Bearer ${CLIENT_KEY}`,
  "Content-Type": "application/json",
});

// ── Health ────────────────────────────────────────────────────────
describe("Health Endpoints", () => {
  test("GET /health returns healthy", async () => {
    const res = await fetch(`${base()}/health`);
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.status).toBe("healthy");
  });
});

// ── Auth ──────────────────────────────────────────────────────────
describe("Authentication", () => {
  test("rejects missing API key", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  test("rejects wrong API key", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers(), "Authorization": "Bearer wrong" },
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts valid API key", async () => {
    const res = await fetch(`${base()}/v1/models`, { headers: headers() });
    expect(res.status).toBe(200);
  });
});

// ── OpenAI Routes ─────────────────────────────────────────────────
describe("OpenAI Routes", () => {
  test("GET /v1/models lists available models", async () => {
    const res = await fetch(`${base()}/v1/models`, { headers: headers() });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.object).toBe("list");
    expect(data.data.length).toBeGreaterThan(0);
  });

  test("POST /v1/chat/completions non-streaming", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Hello" }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.choices).toBeDefined();
    expect(data.choices[0].message.content).toBe("Test response OK");
  });

  test("POST /v1/chat/completions streaming", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: "Hello" }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data:");
    expect(text).toContain("[DONE]");
  });

  test("rejects unknown model", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "nonexistent-xyz", messages: [{ role: "user", content: "Hello" }] }),
    });
    expect(res.status).toBe(400);
  });
});

// ── Anthropic Routes ──────────────────────────────────────────────
describe("Anthropic Routes", () => {
  test("POST /v1/messages non-streaming", async () => {
    const res = await fetch(`${base()}/v1/messages`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 1024,
      }),
    });
    // The response comes back after conversion from OpenAI
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    // Should be converted to Anthropic format
    expect(data.type).toBe("message");
    expect(data.content).toBeDefined();
  });

  test("POST /v1/messages/count_tokens approximates tokens", async () => {
    const res = await fetch(`${base()}/v1/messages/count_tokens`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "Hello world this is a test" }],
        max_tokens: 1024,
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.input_tokens).toBeGreaterThan(0);
  });
});

// ── Responses Routes ──────────────────────────────────────────────
describe("Responses Routes", () => {
  test("POST /v1/responses with string input", async () => {
    const res = await fetch(`${base()}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "test-model", input: "Tell me a joke" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.object).toBe("response");
    expect(data.status).toBe("completed");
    expect(data.output.length).toBeGreaterThan(0);
  });

  test("POST /v1/responses with array input", async () => {
    const res = await fetch(`${base()}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        model: "test-model",
        input: [
          { type: "message", role: "user", content: "Hello" },
          { type: "message", role: "assistant", content: "Hi" },
          { type: "message", role: "user", content: "How are you?" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.object).toBe("response");
  });

  test("POST /v1/responses streaming emits events", async () => {
    const res = await fetch(`${base()}/v1/responses`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "test-model", input: "Stream test", stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("response.created");
    expect(text).toContain("response.completed");
  });
});

// ── GenAI Routes ──────────────────────────────────────────────────
describe("GenAI Routes", () => {
  test("POST /v1/genai/generateContent with string", async () => {
    const res = await fetch(`${base()}/v1/genai/generateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "test-model", contents: "What is AI?" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.candidates).toBeDefined();
    expect(data.candidates[0].content.role).toBe("model");
  });

  test("POST /v1/genai/streamGenerateContent streams", async () => {
    const res = await fetch(`${base()}/v1/genai/streamGenerateContent`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "test-model", contents: "Stream me" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data:");
  });
});

// ── Fallback Routing ──────────────────────────────────────────────
describe("Fallback Routing", () => {
  test("falls back to second provider when first fails", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "fallback-model", messages: [{ role: "user", content: "Fallback test" }] }),
    });
    expect(res.status).toBe(200);
    const data = await res.json() as any;
    expect(data.choices[0].message.content).toBe("Test response OK");
  });

  test("fallback works in streaming too", async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ model: "fallback-model", messages: [{ role: "user", content: "Stream fallback" }], stream: true }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");
  });
});

// ── Concurrent Load ───────────────────────────────────────────────
describe("Concurrent Load", () => {
  test("handles 10 simultaneous non-streaming requests", async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: `Req ${i}` }] }),
      })
    );
    const results = await Promise.all(promises);
    for (const res of results) expect(res.status).toBe(200);
  });

  test("handles 20 simultaneous streaming requests", async () => {
    const promises = Array.from({ length: 20 }, (_, i) =>
      fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: `Stream ${i}` }], stream: true }),
      })
    );
    const results = await Promise.all(promises);
    for (const res of results) expect(res.status).toBe(200);
  });

  test("handles 50 mixed requests", async () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      fetch(`${base()}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "test-model", messages: [{ role: "user", content: `Mixed ${i}` }], stream: i % 2 === 0 }),
      })
    );
    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 200).length;
    expect(successes).toBe(50);
  });
});
