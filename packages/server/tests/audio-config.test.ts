import { rmWithRetry } from "./support.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AudioModelConfigLoader } from "../src/config/audio-model-loader.ts";
import { modelConfigLoader } from "../src/config/model-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";

const tmpRoot = join(tmpdir(), `mp-v2-audio-config-${process.pid}-${Date.now()}`);

beforeAll(() => {
  mkdirSync(join(tmpRoot, "audio-models"), { recursive: true });
  mkdirSync(join(tmpRoot, "models"), { recursive: true });

  writeFileSync(
    join(tmpRoot, "audio-models", "speech.json"),
    JSON.stringify({
      logical_name: "speech",
      timeout_seconds: 30,
      default_cooldown_seconds: 0,
      audio_routings: [
        {
          provider: "openai",
          model: "gpt-4o-mini-transcribe",
          format: "openai_audio",
          capabilities: { streaming: true },
        },
      ],
      fallback_audio_routings: [],
    }),
  );

  writeFileSync(
    join(tmpRoot, "models", "chat-only.json"),
    JSON.stringify({
      logical_name: "chat-only",
      model_routings: [{ provider: "openai", model: "gpt-4o-mini" }],
      fallback_model_routings: [],
    }),
  );
});

afterAll(() => {
  rmWithRetry(tmpRoot, { recursive: true, force: true });
});

describe("AudioModelConfigLoader", () => {
  test("loads and validates audio model config", () => {
    const loader = new AudioModelConfigLoader({ configDir: tmpRoot });
    const config = loader.loadConfig("speech");
    expect(config.logical_name).toBe("speech");
    expect(config.audio_routings[0]?.format).toBe("openai_audio");
    expect(config.audio_routings[0]?.capabilities?.streaming).toBe(true);
  });

  test("lists audio models without polluting chat model discovery", () => {
    const loader = new AudioModelConfigLoader({ configDir: tmpRoot });
    expect(loader.getAvailableModels()).toEqual(["speech"]);

    try {
      setPrimaryConfigDirForTests(tmpRoot);
      modelConfigLoader.clearCache();
      expect(modelConfigLoader.getAvailableModels()).toEqual(["chat-only"]);
    } finally {
      setPrimaryConfigDirForTests(undefined);
      modelConfigLoader.clearCache();
    }
  });
});

