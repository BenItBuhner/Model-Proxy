import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import type { ResolvedAudioRoute } from "@model-proxy/contracts/schemas/audio-routing.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { AudioProviderCapabilityError } from "../src/audio/base.ts";
import { NvidiaNimHttpAudioProvider } from "../src/audio/nvidia-nim-http-audio-provider.ts";

const tmpRoot = join(tmpdir(), `mp-v2-nim-audio-${process.pid}-${Date.now()}`);
const originalFetch = globalThis.fetch;

beforeAll(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  setPrimaryConfigDirForTests(tmpRoot);
  writeFileSync(
    join(tmpRoot, "providers", "nim.json"),
    JSON.stringify({
      name: "nim",
      display_name: "NIM",
      enabled: true,
      api_keys: { env_var_patterns: ["NIM_API_KEY"] },
      endpoints: {
        base_url: "https://nim.example",
        completions: "/v1/audio/transcriptions",
        audio_transcriptions: "/v1/audio/transcriptions",
        compatible_format: "openai",
      },
      authentication: { type: "none" },
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
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("NvidiaNimHttpAudioProvider", () => {
  test("maps OpenAI language to NIM language", async () => {
    let seenBody: FormData | undefined;
    mockFetch(async (_url, init) => {
      seenBody = init?.body as FormData;
      return new Response(JSON.stringify({ text: "hello" }), {
        headers: { "content-type": "application/json" },
      });
    });

    const response = await new NvidiaNimHttpAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: new File(["audio"], "sample.wav"),
      signal: undefined,
      request: {
        model: "logical",
        language: "en-GB",
        response_format: "json",
        timestamp_granularities: [],
        include: [],
        stream: false,
      },
    });

    expect(response.status).toBe(200);
    expect(seenBody?.get("language")).toBe("en-GB");
  });

  test("uses default language and normalizes NIM transcript JSON", async () => {
    mockFetch(async (_url, init) => {
      const body = init?.body as FormData;
      expect(body.get("language")).toBe("en-US");
      return new Response(JSON.stringify({ transcript: "normalized" }), {
        headers: { "content-type": "application/json" },
      });
    });

    const response = await new NvidiaNimHttpAudioProvider().transcribe({
      route: route(),
      formData: new FormData(),
      file: new File(["audio"], "sample.wav"),
      signal: undefined,
      request: {
        model: "logical",
        response_format: "json",
        timestamp_granularities: [],
        include: [],
        stream: false,
      },
    });

    expect(JSON.parse(String(response.body))).toEqual({
      text: "normalized",
    });
  });

  test("rejects unsupported timestamp and SRT modes cleanly", async () => {
    const provider = new NvidiaNimHttpAudioProvider();
    await expect(
      provider.transcribe({
        route: route(),
        formData: new FormData(),
        file: new File(["audio"], "sample.wav"),
        signal: undefined,
        request: {
          model: "logical",
          response_format: "srt",
          timestamp_granularities: ["word"],
          include: [],
          stream: false,
        },
      }),
    ).rejects.toBeInstanceOf(AudioProviderCapabilityError);
  });
});

function route(): ResolvedAudioRoute {
  return {
    sourceLogicalModel: "logical",
    provider: "nim",
    model: "nvidia/canary-1b",
    format: "nvidia_nim_http",
    baseUrl: undefined,
    apiKey: "",
    apiKeyEnvVar: "(none)",
    timeoutSeconds: 5,
    cooldownSeconds: 0,
    languageDefault: "en-US",
    responseFormatDefault: undefined,
    capabilities: {
      streaming: false,
      text: false,
      verbose_json: false,
      srt: false,
      vtt: false,
      timestamps: false,
    },
  };
}

function mockFetch(
  fn: (url: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = fn as typeof fetch;
}

