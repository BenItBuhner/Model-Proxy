import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { audioModelConfigLoader } from "../src/config/audio-model-loader.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { createApp } from "../src/server/app.ts";

const tmpRoot = join(tmpdir(), `mp-v2-audio-${process.pid}-${Date.now()}`);
const originalFetch = globalThis.fetch;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  mkdirSync(join(tmpRoot, "audio-models"), { recursive: true });
  setPrimaryConfigDirForTests(tmpRoot);
  (providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
  (audioModelConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];

  writeProvider("fake-audio", "https://fake-audio.local/openai/v1", "bearer");
  writeProvider("fake-nim", "https://nim.local", "none");
  writeAudioModel("stt", [
    {
      provider: "fake-audio",
      model: "whisper-test",
      format: "openai_audio",
      capabilities: {
        streaming: true,
        text: true,
        verbose_json: true,
        srt: true,
        vtt: true,
        timestamps: true,
      },
    },
  ]);
  writeAudioModel("fallback-stt", [
    {
      provider: "fake-audio",
      model: "first",
      format: "openai_audio",
      capabilities: { streaming: false, text: true, verbose_json: true },
    },
    {
      provider: "fake-audio",
      model: "second",
      format: "openai_audio",
      capabilities: { streaming: false, text: true, verbose_json: true },
    },
  ]);
  writeAudioModel("nim-stt", [
    {
      provider: "fake-nim",
      model: "nvidia/canary-1b",
      format: "nvidia_nim_http",
      language_default: "en-US",
      capabilities: { streaming: false, text: false, verbose_json: false },
    },
  ]);

  process.env.CLIENT_API_KEY = "audio-admin-key";
  process.env.FAKE_AUDIO_API_KEY = "audio-provider-key";
  app = createApp();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetKeyState("fake-audio");
  resetKeyState("fake-nim");
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLIENT_API_KEY;
  delete process.env.FAKE_AUDIO_API_KEY;
  setPrimaryConfigDirForTests(undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("audio transcription routes", () => {
  test("requires auth", async () => {
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      body: form({ model: "stt" }),
    });
    expect(res.status).toBe(401);
  });

  test("accepts a valid admin session cookie", async () => {
    mockFetch(async () => jsonResponse({ text: "hello session" }));
    const loginRes = await app.request("/v1/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: "audio-admin-key" }),
    });
    const cookie = loginRes.headers.get("set-cookie") ?? "";
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: { cookie },
      body: form({ model: "stt" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello session" });
  });

  test("missing file or url returns 400", async () => {
    const fd = new FormData();
    fd.set("model", "stt");
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: auth(),
      body: fd,
    });
    expect(res.status).toBe(400);
  });

  test("non-streaming OpenAI-compatible provider returns JSON", async () => {
    mockFetch(async (_url, init) => {
      const body = init?.body as FormData;
      expect(body.get("model")).toBe("whisper-test");
      expect(body.get("language")).toBe("en");
      return jsonResponse({ text: "hello world", x_provider: { id: "debug" } });
    });
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: auth(),
      body: form({ model: "stt", language: "en-US" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ text: "hello world" });
  });

  test("text response preserves text/plain", async () => {
    mockFetch(async () =>
      new Response("plain transcript", {
        headers: { "content-type": "text/plain" },
      }),
    );
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: auth(),
      body: form({ model: "stt", response_format: "text" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toBe("plain transcript");
  });

  test("provider failure falls back to next audio route", async () => {
    let calls = 0;
    mockFetch(async () => {
      calls += 1;
      if (calls === 1) return new Response("boom", { status: 500 });
      return jsonResponse({ text: "fallback ok" });
    });
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: auth(),
      body: form({ model: "fallback-stt" }),
    });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(await res.json()).toEqual({ text: "fallback ok" });
  });

  test("streaming passes through SSE", async () => {
    mockFetch(async (_url, init) => {
      const body = init?.body as FormData;
      expect(body.get("stream")).toBe("true");
      return new Response("data: {\"type\":\"delta\",\"delta\":\"hi\"}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: auth(),
      body: form({ model: "stt", stream: "true" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("delta");
  });

  test("NVIDIA NIM HTTP maps language and normalizes response", async () => {
    mockFetch(async (_url, init) => {
      const body = init?.body as FormData;
      expect(body.get("language")).toBe("en-US");
      return jsonResponse({ transcript: "nim transcript" });
    });
    const res = await app.request("/v1/audio/transcriptions", {
      method: "POST",
      headers: auth(),
      body: form({ model: "nim-stt" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "nim transcript" });
  });
});

function auth(): Record<string, string> {
  return { Authorization: "Bearer audio-admin-key" };
}

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  fd.set("file", new File(["audio"], "sample.wav", { type: "audio/wav" }));
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(
  fn: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = fn as typeof fetch;
}

function writeProvider(
  name: string,
  baseUrl: string,
  authType: "bearer" | "none",
): void {
  writeFileSync(
    join(tmpRoot, "providers", `${name}.json`),
    JSON.stringify({
      name,
      display_name: name,
      enabled: true,
      api_keys: {
        env_var_patterns: [
          `${name.toUpperCase().replaceAll("-", "_")}_API_KEY`,
        ],
      },
      endpoints: {
        base_url: baseUrl,
        completions: "/chat/completions",
        audio_transcriptions: "/audio/transcriptions",
        compatible_format: "openai",
      },
      authentication:
        authType === "none"
          ? { type: "none" }
          : {
              type: "bearer",
              header_name: "Authorization",
              header_format: "Bearer {api_key}",
            },
    }),
  );
}

function writeAudioModel(name: string, routes: Array<Record<string, unknown>>): void {
  writeFileSync(
    join(tmpRoot, "audio-models", `${name}.json`),
    JSON.stringify({
      logical_name: name,
      timeout_seconds: 15,
      default_cooldown_seconds: 0,
      audio_routings: routes,
      fallback_audio_routings: [],
    }),
  );
}

