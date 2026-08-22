import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { ResolvedAudioRoute } from "@model-proxy/contracts/schemas/audio-routing.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { OpenAICompatibleAudioProvider } from "../src/audio/openai-compatible-audio-provider.ts";

const tmpRoot = join(tmpdir(), `mp-v2-openai-audio-${process.pid}-${Date.now()}`);
const originalFetch = globalThis.fetch;

beforeAll(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  (providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
  writeFileSync(
    join(tmpRoot, "providers", "audio-openai.json"),
    JSON.stringify({
      name: "audio-openai",
      display_name: "Audio OpenAI",
      enabled: true,
      api_keys: { env_var_patterns: ["AUDIO_OPENAI_API_KEY"] },
      endpoints: {
        base_url: "https://audio.example/v1",
        completions: "/chat/completions",
        audio_transcriptions: "/audio/transcriptions",
        compatible_format: "openai",
      },
      authentication: {
        type: "bearer",
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
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("OpenAICompatibleAudioProvider", () => {
  test("forwards multipart fields including timestamp granularities", async () => {
    let seenBody: FormData | undefined;
    let seenHeaders: RequestInit["headers"];
    mockFetch(async (_url, init) => {
      seenBody = init?.body as FormData;
      seenHeaders = init?.headers;
      return new Response(JSON.stringify({ text: "ok", x_groq: { id: "debug" } }), {
        headers: { "content-type": "application/json" },
      });
    });

    const provider = new OpenAICompatibleAudioProvider();
    const response = await provider.transcribe({
      route: route({ streaming: true, timestamps: true }),
      formData: new FormData(),
      file: new File(["audio"], "sample.wav", { type: "audio/wav" }),
      signal: undefined,
      request: {
        model: "logical",
        language: "en",
        prompt: "names: Nahcrof",
        response_format: "verbose_json",
        temperature: 0.1,
        timestamp_granularities: ["word", "segment"],
        include: ["logprobs"],
        stream: false,
      },
    });

    expect(response.status).toBe(200);
    expect(await new Response(response.body).json()).toEqual({
      text: "ok",
    });
    expect(seenBody?.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(seenBody?.get("language")).toBe("en");
    expect(seenBody?.get("prompt")).toBe("names: Nahcrof");
    expect(seenBody?.get("response_format")).toBe("verbose_json");
    expect(seenBody?.getAll("timestamp_granularities[]")).toEqual([
      "word",
      "segment",
    ]);
    expect(seenBody?.getAll("include[]")).toEqual(["logprobs"]);
    expect((seenHeaders as Record<string, string>)["Authorization"]).toBe(
      "Bearer provider-key",
    );
  });

  test("passes stream=true through as SSE", async () => {
    mockFetch(async (_url, init) => {
      const body = init?.body as FormData;
      expect(body.get("stream")).toBe("true");
      return new Response("data: {}\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    });

    const provider = new OpenAICompatibleAudioProvider();
    const response = await provider.transcribe({
      route: route({ streaming: true }),
      formData: new FormData(),
      file: new File(["audio"], "sample.wav"),
      signal: undefined,
      request: {
        model: "logical",
        response_format: "json",
        timestamp_granularities: [],
        include: [],
        stream: true,
      },
    });

    expect(response.streaming).toBe(true);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
  });
});

function route(capabilities: ResolvedAudioRoute["capabilities"]): ResolvedAudioRoute {
  return {
    sourceLogicalModel: "logical",
    provider: "audio-openai",
    model: "gpt-4o-mini-transcribe",
    format: "openai_audio",
    baseUrl: undefined,
    apiKey: "provider-key",
    apiKeyEnvVar: "AUDIO_OPENAI_API_KEY",
    timeoutSeconds: 5,
    cooldownSeconds: 0,
    languageDefault: undefined,
    responseFormatDefault: undefined,
    capabilities,
  };
}

function mockFetch(
  fn: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = fn as typeof fetch;
}

