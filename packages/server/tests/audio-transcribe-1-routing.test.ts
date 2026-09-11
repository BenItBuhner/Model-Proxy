import { rmWithRetry } from "./support.ts";
import { copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { audioModelConfigLoader } from "../src/config/audio-model-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { createApp } from "../src/server/app.ts";
import { resetRequestLogForTests } from "../src/server/request-log.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

/**
 * End-to-end routing check for the shipped `transcribe-1` configuration. The
 * real `config/audio-models/transcribe-1.json`, `config/providers/gemini.json`
 * and `config/providers/groq.json` are copied into a hermetic config dir, so
 * this also proves the committed JSON validates and its provider names resolve.
 */

const repoConfig = resolve(import.meta.dir, "..", "..", "..", "config");
const tmpRoot = join(tmpdir(), `mp-v2-transcribe-1-${process.pid}-${Date.now()}`);
const originalFetch = globalThis.fetch;
/**
 * Other suites hydrate secrets (e.g. bundle imports with GROQ_API_KEY_1..n)
 * straight into process.env and leave them there. Pin the key pool to exactly
 * one key per provider so attempt counts below are deterministic.
 */
const PROVIDER_KEY_PATTERN = /^(GEMINI|GROQ)_API_KEY(_\d+)?$/;
const savedProviderKeys = new Map<string, string>();
let app: ReturnType<typeof createApp>;

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent";
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  model: string | undefined;
  form: FormData | undefined;
  json: unknown;
}

beforeAll(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  mkdirSync(join(tmpRoot, "audio-models"), { recursive: true });
  copyFileSync(join(repoConfig, "providers", "gemini.json"), join(tmpRoot, "providers", "gemini.json"));
  copyFileSync(join(repoConfig, "providers", "groq.json"), join(tmpRoot, "providers", "groq.json"));
  copyFileSync(
    join(repoConfig, "audio-models", "transcribe-1.json"),
    join(tmpRoot, "audio-models", "transcribe-1.json"),
  );
  setPrimaryConfigDirForTests(tmpRoot);
  setStorageRootForTests(join(tmpRoot, ".storage"));

  for (const [key, value] of Object.entries(process.env)) {
    if (!PROVIDER_KEY_PATTERN.test(key) || value === undefined) continue;
    savedProviderKeys.set(key, value);
    delete process.env[key];
  }
  process.env.CLIENT_API_KEY = "transcribe-admin-key";
  process.env.GEMINI_API_KEY = "gemini-test-key";
  process.env.GROQ_API_KEY = "groq-test-key";
  resetKeyState("gemini");
  resetKeyState("groq");
  app = createApp();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetKeyState("gemini");
  resetKeyState("groq");
  resetRequestLogForTests();
  rmWithRetry(join(tmpRoot, ".storage"), { recursive: true, force: true });
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CLIENT_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GROQ_API_KEY;
  for (const [key, value] of savedProviderKeys) process.env[key] = value;
  setPrimaryConfigDirForTests(undefined);
  setStorageRootForTests(undefined);
  providerConfigLoader.clearCache();
  audioModelConfigLoader.clearCache();
  rmWithRetry(tmpRoot, { recursive: true, force: true });
});

describe("transcribe-1 shipped configuration", () => {
  test("is the only audio model exposed by /v1/audio/models", async () => {
    const res = await app.request("/v1/audio/models", { headers: auth() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };
    expect(body.data.map((entry) => entry.id)).toEqual(["transcribe-1"]);
  });

  test("routes Gemini first, then Groq whisper-large-v3, then whisper-large-v3-turbo", () => {
    const config = audioModelConfigLoader.loadConfig("transcribe-1");
    expect(config.audio_routings.map((route) => `${route.provider}/${route.model}/${route.format}`)).toEqual([
      "gemini/gemini-3.5-transcribe/gemini_transcribe",
      "groq/whisper-large-v3/openai_audio",
      "groq/whisper-large-v3-turbo/openai_audio",
    ]);
    expect(config.fallback_audio_routings).toEqual([]);
  });
});

describe("transcribe-1 routing order", () => {
  test("a healthy Gemini answers alone, using the Gemini key against the native API", async () => {
    const calls = mockUpstream(() => geminiOk("hello from gemini"));
    const res = await transcribe({ model: "transcribe-1", language: "en" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello from gemini" });

    expect(calls.map((call) => call.url)).toEqual([GEMINI_URL]);
    expect(calls[0]!.headers["x-goog-api-key"]).toBe("gemini-test-key");
    expect(calls[0]!.json).toMatchObject({
      generationConfig: { audioTranscriptionConfig: { languageCodes: ["en-US"] } },
    });
  });

  test("falls back to Groq whisper-large-v3 when Gemini fails", async () => {
    const calls = mockUpstream((url) =>
      url === GEMINI_URL
        ? geminiError(503, "UNAVAILABLE", "try again later")
        : groqOk("hello from groq"),
    );
    const res = await transcribe({ model: "transcribe-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello from groq" });

    expect(calls.map((call) => call.url)).toEqual([GEMINI_URL, GROQ_URL]);
    expect(calls[1]!.headers["authorization"]).toBe("Bearer groq-test-key");
    expect(calls[1]!.model).toBe("whisper-large-v3");
  });

  test("walks the full chain when both Gemini and whisper-large-v3 fail", async () => {
    const calls = mockUpstream((url, form) => {
      if (url === GEMINI_URL) return geminiError(500, "INTERNAL", "boom");
      if (form?.get("model") === "whisper-large-v3") return new Response("busy", { status: 503 });
      return groqOk("hello from turbo");
    });
    const res = await transcribe({ model: "transcribe-1" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello from turbo" });
    expect(calls.map((call) => call.model ?? "gemini-3.5-transcribe")).toEqual([
      "gemini-3.5-transcribe",
      "whisper-large-v3",
      "whisper-large-v3-turbo",
    ]);
  });

  test("returns 503 with every attempt listed when the whole chain fails", async () => {
    mockUpstream((url) =>
      url === GEMINI_URL
        ? geminiError(500, "INTERNAL", "gemini down")
        : new Response("groq down", { status: 502 }),
    );
    const res = await transcribe({ model: "transcribe-1" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("service_unavailable");
    expect(body.error.message).toContain("transcribe-1");
  });
});

describe("transcribe-1 cooldown semantics", () => {
  test("a Gemini 500 (fallback_no_cooldown) does not bench the Gemini key", async () => {
    let geminiCalls = 0;
    mockUpstream((url) => {
      if (url === GEMINI_URL) {
        geminiCalls += 1;
        return geminiCalls === 1 ? geminiError(500, "INTERNAL", "hiccup") : geminiOk("recovered");
      }
      return groqOk("groq covered");
    });

    const first = await transcribe({ model: "transcribe-1" });
    expect(await first.json()).toEqual({ text: "groq covered" });

    const second = await transcribe({ model: "transcribe-1" });
    expect(await second.json()).toEqual({ text: "recovered" });
    expect(geminiCalls).toBe(2);
  });

  test("a Gemini 429 (model_key_failure) benches the key so the next request goes straight to Groq", async () => {
    let geminiCalls = 0;
    mockUpstream((url) => {
      if (url === GEMINI_URL) {
        geminiCalls += 1;
        return geminiError(429, "RESOURCE_EXHAUSTED", "quota");
      }
      return groqOk("groq covered");
    });

    expect(await (await transcribe({ model: "transcribe-1" })).json()).toEqual({ text: "groq covered" });
    expect(await (await transcribe({ model: "transcribe-1" })).json()).toEqual({ text: "groq covered" });
    expect(geminiCalls).toBe(1);
  });
});

describe("transcribe-1 capability routing", () => {
  test("stream=true is rejected with 422 without calling any upstream", async () => {
    const calls = mockUpstream(() => geminiOk("unreachable"));
    const res = await transcribe({ model: "transcribe-1", stream: "true" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("unsupported_audio_feature");
    expect(body.error.message).toContain("streaming");
    expect(calls).toHaveLength(0);
  });

  test("URL input skips Gemini and goes to Groq, which supports it", async () => {
    const calls = mockUpstream(() => groqOk("from url"));
    const fd = new FormData();
    fd.set("model", "transcribe-1");
    fd.set("url", "https://example.com/audio.mp3");
    const res = await app.request("/v1/audio/transcriptions", { method: "POST", headers: auth(), body: fd });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "from url" });
    expect(calls.map((call) => call.url)).toEqual([GROQ_URL]);
    expect(calls[0]!.form?.get("url")).toBe("https://example.com/audio.mp3");
  });

  test("srt output is served by Gemini and never reaches Groq", async () => {
    const calls = mockUpstream(() =>
      geminiOk("Hello world.", [
        { word: "Hello", startOffset: "0.100s", endOffset: "0.450s" },
        { word: "world.", startOffset: "0.500s", endOffset: "0.850s" },
      ]),
    );
    const res = await transcribe({ model: "transcribe-1", response_format: "srt" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-subrip");
    expect(await res.text()).toBe("1\n00:00:00,100 --> 00:00:00,850\nHello world.\n");
    expect(calls.map((call) => call.url)).toEqual([GEMINI_URL]);
    expect(calls[0]!.json).toMatchObject({
      generationConfig: { audioTranscriptionConfig: { wordTimestamp: true } },
    });
  });

  test("srt output is a 503 when Gemini is down, since Groq cannot render it and is skipped", async () => {
    const calls = mockUpstream(() => geminiError(503, "UNAVAILABLE", "down"));
    const res = await transcribe({ model: "transcribe-1", response_format: "srt" });
    // Gemini failed for real, so this is an availability problem, not a capability one.
    expect(res.status).toBe(503);
    expect(calls.map((call) => call.url)).toEqual([GEMINI_URL]);
  });
});

function auth(): Record<string, string> {
  return { Authorization: "Bearer transcribe-admin-key" };
}

async function transcribe(fields: Record<string, string>): Promise<Response> {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array([1, 2, 3])], "sample.wav", { type: "audio/wav" }));
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return app.request("/v1/audio/transcriptions", { method: "POST", headers: auth(), body: fd });
}

function geminiOk(
  text: string,
  words?: Array<{ word: string; startOffset: string; endOffset: string }>,
): Response {
  const part: Record<string, unknown> = { text };
  if (words !== undefined) part.audioTranscription = { words };
  return json({ candidates: [{ content: { parts: [part], role: "model" }, finishReason: "STOP" }] });
}

function geminiError(status: number, code: string, message: string): Response {
  return json({ error: { code: status, message, status: code } }, status);
}

function groqOk(text: string): Response {
  return json({ text, x_groq: { id: "req_debug" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockUpstream(
  handler: (url: string, form: FormData | undefined) => Response | Promise<Response>,
): UpstreamCall[] {
  const calls: UpstreamCall[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const form = init?.body instanceof FormData ? init.body : undefined;
    const modelField = form?.get("model");
    let parsed: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        parsed = JSON.parse(init.body);
      } catch {
        parsed = init.body;
      }
    }
    calls.push({
      url,
      headers,
      model: typeof modelField === "string" ? modelField : undefined,
      form,
      json: parsed,
    });
    return handler(url, form);
  }) as typeof fetch;
  return calls;
}
