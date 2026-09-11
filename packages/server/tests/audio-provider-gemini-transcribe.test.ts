import { rmWithRetry } from "./support.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { ResolvedAudioRoute } from "@model-proxy/contracts/schemas/audio-routing.ts";
import type { AudioTranscriptionRequest } from "@model-proxy/contracts/schemas/audio-wire.ts";
import { ProviderConfigSchema } from "@model-proxy/contracts/schemas/provider.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import {
  AudioProviderCapabilityError,
  AudioProviderUpstreamError,
} from "../src/audio/base.ts";
import {
  GeminiTranscribeAudioProvider,
  resolveApiBase,
  resolveMimeType,
  uploadBase,
} from "../src/audio/gemini-transcribe-audio-provider.ts";

const tmpRoot = join(tmpdir(), `mp-v2-gemini-audio-${process.pid}-${Date.now()}`);
const originalFetch = globalThis.fetch;

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: RequestInit["body"];
}

beforeAll(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  setPrimaryConfigDirForTests(tmpRoot);
  // Mirrors the shipped gemini provider: base_url points at the OpenAI facade.
  writeFileSync(
    join(tmpRoot, "providers", "gemini.json"),
    JSON.stringify({
      name: "gemini",
      type: "gemini",
      enabled: true,
      api_keys: { env_var_patterns: ["GEMINI_API_KEY", "GEMINI_API_KEY_{INDEX}"] },
      endpoints: {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai/",
        completions: "chat/completions",
        compatible_format: "openai",
      },
      authentication: {
        type: "api_key",
        header_name: "Authorization",
        header_format: "Bearer {api_key}",
      },
    }),
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  providerConfigLoader.clearCache();
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  setPrimaryConfigDirForTests(undefined);
  rmWithRetry(tmpRoot, { recursive: true, force: true });
});

describe("GeminiTranscribeAudioProvider (inline audio)", () => {
  test("posts inline base64 audio to the native generateContent endpoint", async () => {
    const calls = recordFetch(() => geminiJson({ text: "hello from gemini" }));
    const audio = new File([new Uint8Array([1, 2, 3, 4])], "clip.wav", { type: "audio/x-wav" });

    const response = await new GeminiTranscribeAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: audio,
      signal: undefined,
      request: request({ language: "en", prompt: "Nahcrof, Kubernetes" }),
    });

    expect(response.status).toBe(200);
    expect(response.streaming).toBe(false);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.parse(String(response.body))).toEqual({ text: "hello from gemini" });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent",
    );
    expect(call.method).toBe("POST");
    expect(call.headers["x-goog-api-key"]).toBe("gemini-secret");
    expect(call.headers["authorization"]).toBeUndefined();
    expect(call.body).toEqual({
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: "audio/wav",
                data: Buffer.from([1, 2, 3, 4]).toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: {
        audioTranscriptionConfig: {
          languageCodes: ["en-US"],
          customVocabulary: ["Nahcrof", "Kubernetes"],
        },
      },
    });
  });

  test("uses the route language default and auto-detects when nothing is set", async () => {
    const calls = recordFetch(() => geminiJson({ text: "ok" }));
    await new GeminiTranscribeAudioProvider().transcribe({
      route: { ...route(), languageDefault: "de" },
      formData: new FormData(),
      file: wav(),
      signal: undefined,
      request: request({}),
    });
    await new GeminiTranscribeAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: wav(),
      signal: undefined,
      request: request({}),
    });
    expect(configOf(calls[0])).toEqual({ languageCodes: ["de-DE"] });
    expect(configOf(calls[1])).toEqual({});
  });

  test("verbose_json requests word timestamps, drops the incompatible vocabulary, and renders segments", async () => {
    const calls = recordFetch(() =>
      geminiJson({
        text: "Hello world.",
        words: [
          { word: "Hello", startOffset: "0.100s", endOffset: "0.450s" },
          { word: "world", startOffset: "0.500s", endOffset: "0.850s" },
        ],
      }),
    );
    const response = await new GeminiTranscribeAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: wav(),
      signal: undefined,
      request: request({
        response_format: "verbose_json",
        prompt: "vocab hint",
        timestamp_granularities: ["word", "segment"],
      }),
    });

    expect(configOf(calls[0])).toEqual({ wordTimestamp: true });
    expect(JSON.parse(String(response.body))).toEqual({
      task: "transcribe",
      duration: 0.85,
      text: "Hello world.",
      segments: [{ id: 0, seek: 0, start: 0.1, end: 0.85, text: "Hello world." }],
      words: [
        { word: "Hello", start: 0.1, end: 0.45 },
        { word: "world", start: 0.5, end: 0.85 },
      ],
    });
  });

  test("diarized_json enables diarization and labels speakers", async () => {
    const calls = recordFetch(() =>
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: "Hi.",
                    audioTranscription: {
                      speakerLabel: "spk_1",
                      words: [{ word: "Hi.", startOffset: "0s", endOffset: "0.3s" }],
                    },
                  },
                  {
                    text: "Hey.",
                    audioTranscription: {
                      speakerLabel: "spk_2",
                      words: [{ word: "Hey.", startOffset: "1s", endOffset: "1.4s" }],
                    },
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const response = await new GeminiTranscribeAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: wav(),
      signal: undefined,
      request: request({ response_format: "diarized_json" }),
    });
    expect(configOf(calls[0])).toEqual({ wordTimestamp: true, diarization: true });
    const body = JSON.parse(String(response.body)) as { segments: Array<{ speaker: string }> };
    expect(body.segments.map((segment) => segment.speaker)).toEqual(["spk_1", "spk_2"]);
  });

  test("text, srt and vtt formats are rendered from the same transcript", async () => {
    const words = [
      { word: "Hello", startOffset: "0.100s", endOffset: "0.450s" },
      { word: "world.", startOffset: "0.500s", endOffset: "0.850s" },
    ];
    const run = async (format: AudioTranscriptionRequest["response_format"]) => {
      recordFetch(() => geminiJson({ text: "Hello world.", words }));
      return new GeminiTranscribeAudioProvider().transcribe({
        route: route(),
        formData: new FormData(),
        file: wav(),
        signal: undefined,
        request: request({ response_format: format }),
      });
    };

    const text = await run("text");
    expect(text.headers.get("content-type")).toContain("text/plain");
    expect(String(text.body)).toBe("Hello world.");

    const srt = await run("srt");
    expect(srt.headers.get("content-type")).toContain("application/x-subrip");
    expect(String(srt.body)).toBe("1\n00:00:00,100 --> 00:00:00,850\nHello world.\n");

    const vtt = await run("vtt");
    expect(vtt.headers.get("content-type")).toContain("text/vtt");
    expect(String(vtt.body)).toBe("WEBVTT\n\n00:00:00.100 --> 00:00:00.850\nHello world.\n");
  });

  test("silent audio with finishReason STOP is a legitimate empty transcript", async () => {
    recordFetch(() =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [], role: "model" }, finishReason: "STOP" }] }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const response = await new GeminiTranscribeAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: wav(),
      signal: undefined,
      request: request({}),
    });
    expect(JSON.parse(String(response.body))).toEqual({ text: "" });
  });
});

describe("GeminiTranscribeAudioProvider (Files API for oversized audio)", () => {
  test("uploads via the resumable protocol, polls until ACTIVE, transcribes, then deletes", async () => {
    let polls = 0;
    const calls = recordFetch((url, init) => {
      if (url === "https://generativelanguage.googleapis.com/upload/v1beta/files") {
        return new Response("", {
          status: 200,
          headers: { "x-goog-upload-url": "https://upload.example/session-1" },
        });
      }
      if (url === "https://upload.example/session-1") {
        return jsonResponse({
          file: {
            name: "files/abc123",
            uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
            mimeType: "audio/mp3",
            state: "PROCESSING",
          },
        });
      }
      if (url === "https://generativelanguage.googleapis.com/v1beta/files/abc123" && init?.method === "DELETE") {
        return new Response("{}", { status: 200 });
      }
      if (url === "https://generativelanguage.googleapis.com/v1beta/files/abc123") {
        polls += 1;
        return jsonResponse({
          name: "files/abc123",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
          mimeType: "audio/mp3",
          state: polls >= 2 ? "ACTIVE" : "PROCESSING",
        });
      }
      return geminiJson({ text: "long transcript" });
    });

    const bigAudio = new File([new Uint8Array(32)], "podcast.mp3", { type: "audio/mpeg3" });
    const provider = new GeminiTranscribeAudioProvider({ inlineMaxBytes: 16, filePollIntervalMs: 1 });
    const response = await provider.transcribe({
      route: route(),
      formData: new FormData(),
      file: bigAudio,
      signal: undefined,
      request: request({}),
    });
    expect(JSON.parse(String(response.body))).toEqual({ text: "long transcript" });

    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://generativelanguage.googleapis.com/upload/v1beta/files",
      "POST https://upload.example/session-1",
      "GET https://generativelanguage.googleapis.com/v1beta/files/abc123",
      "GET https://generativelanguage.googleapis.com/v1beta/files/abc123",
      "POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-transcribe:generateContent",
      "DELETE https://generativelanguage.googleapis.com/v1beta/files/abc123",
    ]);

    const start = calls[0]!;
    expect(start.headers["x-goog-api-key"]).toBe("gemini-secret");
    expect(start.headers["x-goog-upload-protocol"]).toBe("resumable");
    expect(start.headers["x-goog-upload-command"]).toBe("start");
    expect(start.headers["x-goog-upload-header-content-length"]).toBe("32");
    expect(start.headers["x-goog-upload-header-content-type"]).toBe("audio/mp3");
    expect(start.body).toEqual({ file: { display_name: "podcast.mp3" } });

    const upload = calls[1]!;
    expect(upload.headers["x-goog-upload-offset"]).toBe("0");
    expect(upload.headers["x-goog-upload-command"]).toBe("upload, finalize");
    expect(upload.rawBody).toBe(bigAudio);

    const generate = calls[4]!;
    expect(generate.body).toEqual({
      contents: [
        {
          parts: [
            {
              fileData: {
                fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc123",
                mimeType: "audio/mp3",
              },
            },
          ],
        },
      ],
      generationConfig: { audioTranscriptionConfig: {} },
    });
    expect(calls[5]!.headers["x-goog-api-key"]).toBe("gemini-secret");
  });

  test("a failed upload session surfaces as a retryable upstream error", async () => {
    recordFetch(() => new Response("nope", { status: 503 }));
    const provider = new GeminiTranscribeAudioProvider({ inlineMaxBytes: 1 });
    await expect(
      provider.transcribe({
        route: route(),
        formData: new FormData(),
        file: wav(),
        signal: undefined,
        request: request({}),
      }),
    ).rejects.toMatchObject({ name: "AudioProviderUpstreamError", statusCode: 503, retryable: true });
  });
});

describe("GeminiTranscribeAudioProvider (errors and capabilities)", () => {
  test("maps Gemini error envelopes onto AudioProviderUpstreamError", async () => {
    recordFetch(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const promise = new GeminiTranscribeAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: wav(),
      signal: undefined,
      request: request({}),
    });
    await expect(promise).rejects.toBeInstanceOf(AudioProviderUpstreamError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 429,
      retryable: true,
      message: "gemini gemini transcription error 429: Quota exceeded [RESOURCE_EXHAUSTED]",
    });
  });

  test("blocked or empty responses are retryable 502s so the router can fall back", async () => {
    recordFetch(() =>
      jsonResponse({ candidates: [], promptFeedback: { blockReason: "SAFETY" } }),
    );
    await expect(
      new GeminiTranscribeAudioProvider().transcribe({
        route: route(),
        formData: new FormData(),
        file: wav(),
        signal: undefined,
        request: request({}),
      }),
    ).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("SAFETY") });
  });

  test("streaming, translation, URL-only input and unknown MIME types are capability errors", async () => {
    const calls = recordFetch(() => geminiJson({ text: "unreachable" }));
    const provider = new GeminiTranscribeAudioProvider();
    const attempt = (
      overrides: Partial<AudioTranscriptionRequest>,
      file: File | undefined = wav(),
    ) =>
      provider.transcribe({
        route: route(),
        formData: new FormData(),
        file,
        signal: undefined,
        request: request(overrides),
      });

    await expect(attempt({ stream: true })).rejects.toBeInstanceOf(AudioProviderCapabilityError);
    await expect(attempt({ task: "translate" })).rejects.toBeInstanceOf(AudioProviderCapabilityError);
    await expect(attempt({ url: "https://example.com/a.mp3" }, undefined)).rejects.toBeInstanceOf(
      AudioProviderCapabilityError,
    );
    await expect(
      attempt({}, new File([new Uint8Array(4)], "mystery.bin", { type: "application/octet-stream" })),
    ).rejects.toBeInstanceOf(AudioProviderCapabilityError);
    expect(calls).toHaveLength(0);
  });

  test("route capability flags are enforced before any upstream call", async () => {
    const calls = recordFetch(() => geminiJson({ text: "unreachable" }));
    await expect(
      new GeminiTranscribeAudioProvider().transcribe({
        route: { ...route(), capabilities: { srt: false } },
        formData: new FormData(),
        file: wav(),
        signal: undefined,
        request: request({ response_format: "srt" }),
      }),
    ).rejects.toBeInstanceOf(AudioProviderCapabilityError);
    expect(calls).toHaveLength(0);
  });

  test("our own timeout becomes a retryable 504, a client abort is passed through", async () => {
    globalThis.fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      })) as typeof fetch;

    const provider = new GeminiTranscribeAudioProvider();
    await expect(
      provider.transcribe({
        route: { ...route(), timeoutSeconds: 1 },
        formData: new FormData(),
        file: wav(),
        signal: undefined,
        request: request({}),
      }),
    ).rejects.toMatchObject({
      name: "AudioProviderUpstreamError",
      statusCode: 504,
      retryable: true,
    });

    const client = new AbortController();
    client.abort();
    await expect(
      provider.transcribe({
        route: route(),
        formData: new FormData(),
        file: wav(),
        signal: client.signal,
        request: request({}),
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("Gemini transcribe helpers", () => {
  test("resolveApiBase strips the OpenAI facade and honours overrides", () => {
    const base = ProviderConfigSchema.parse({
      name: "gemini",
      api_keys: { env_var_patterns: ["GEMINI_API_KEY"] },
      endpoints: {
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai/",
        completions: "chat/completions",
      },
      authentication: { type: "bearer", header_name: "Authorization" },
    });
    expect(resolveApiBase(undefined, base)).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(resolveApiBase("https://proxy.example/gemini/v1beta/", base)).toBe(
      "https://proxy.example/gemini/v1beta",
    );

    process.env.GEMINI_TEST_BASE = "https://env.example/v1beta";
    try {
      expect(resolveApiBase("${GEMINI_TEST_BASE}", base)).toBe("https://env.example/v1beta");
    } finally {
      delete process.env.GEMINI_TEST_BASE;
    }

    const proxied = ProviderConfigSchema.parse({
      ...base,
      proxy_support: { enabled: true, base_url_override: "https://egress.example/v1beta/openai" },
    });
    expect(resolveApiBase("https://ignored.example/v1beta", proxied)).toBe(
      "https://egress.example/v1beta",
    );
  });

  test("uploadBase inserts the /upload prefix ahead of the API version", () => {
    expect(uploadBase("https://generativelanguage.googleapis.com/v1beta")).toBe(
      "https://generativelanguage.googleapis.com/upload/v1beta",
    );
    expect(uploadBase("https://proxy.example/gemini/v1beta/")).toBe(
      "https://proxy.example/upload/gemini/v1beta",
    );
  });

  test("resolveMimeType normalises aliases, strips codec parameters and sniffs extensions", () => {
    expect(resolveMimeType(new File([], "a.wav", { type: "audio/x-wav" }))).toBe("audio/wav");
    expect(resolveMimeType(new File([], "a.webm", { type: "audio/webm;codecs=opus" }))).toBe(
      "audio/webm",
    );
    expect(resolveMimeType(new File([], "a.m4a", { type: "audio/mp4" }))).toBe("audio/m4a");
    expect(resolveMimeType(new File([], "voice.MP3", { type: "application/octet-stream" }))).toBe(
      "audio/mp3",
    );
    expect(resolveMimeType(new File([], "a.opus", { type: "" }))).toBe("audio/opus");
    expect(resolveMimeType(new Blob([]))).toBeUndefined();
    expect(resolveMimeType(new File([], "a.bin", { type: "application/octet-stream" }))).toBeUndefined();
  });
});

function route(): ResolvedAudioRoute {
  return {
    sourceLogicalModel: "transcribe-1",
    provider: "gemini",
    model: "gemini-3.5-transcribe",
    format: "gemini_transcribe",
    baseUrl: undefined,
    apiKey: "gemini-secret",
    apiKeyEnvVar: "GEMINI_API_KEY",
    timeoutSeconds: 30,
    cooldownSeconds: 0,
    languageDefault: undefined,
    responseFormatDefault: undefined,
    capabilities: {
      streaming: false,
      text: true,
      verbose_json: true,
      srt: true,
      vtt: true,
      timestamps: true,
      url_input: false,
    },
  };
}

function request(overrides: Partial<AudioTranscriptionRequest>): AudioTranscriptionRequest {
  return {
    model: "transcribe-1",
    response_format: "json",
    timestamp_granularities: [],
    include: [],
    stream: false,
    ...overrides,
  };
}

function wav(): File {
  return new File([new Uint8Array([9, 9, 9])], "sample.wav", { type: "audio/wav" });
}

function geminiJson(options: {
  text: string;
  words?: Array<{ word: string; startOffset: string; endOffset: string }>;
}): Response {
  const part: Record<string, unknown> = { text: options.text };
  if (options.words !== undefined) part.audioTranscription = { words: options.words };
  return jsonResponse({
    candidates: [{ content: { parts: [part], role: "model" }, finishReason: "STOP" }],
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function configOf(call: RecordedCall | undefined): unknown {
  const body = call?.body as { generationConfig?: { audioTranscriptionConfig?: unknown } } | undefined;
  return body?.generationConfig?.audioTranscriptionConfig;
}

function recordFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ url, method: init?.method ?? "GET", headers, body, rawBody: init?.body });
    return handler(url, init);
  }) as typeof fetch;
  return calls;
}
