import { describe, expect, test } from "bun:test";

import { AudioRouteConfigSchema } from "@model-proxy/contracts/schemas/audio-routing.ts";
import { AudioTranscriptionRequestSchema } from "@model-proxy/contracts/schemas/audio-wire.ts";

import {
  AudioProviderCapabilityError,
  requireAudioCapabilities,
} from "../src/audio/base.ts";

function route(capabilities?: Record<string, boolean>) {
  return AudioRouteConfigSchema.parse({
    provider: "openai",
    model: "whisper-1",
    ...(capabilities === undefined ? {} : { capabilities }),
  });
}

function request(overrides: Record<string, unknown> = {}) {
  return AudioTranscriptionRequestSchema.parse({
    model: "speech",
    ...overrides,
  });
}

function capabilitiesOf(capabilities?: Record<string, boolean>) {
  return route(capabilities).capabilities ?? {};
}

describe("audio route capabilities", () => {
  test("a route with no capabilities leaves streaming, SRT, VTT, timestamps, and URL input unset", () => {
    const omitted = route();
    expect(omitted.capabilities).toBeUndefined();

    const empty = route({});
    expect(empty.capabilities).toEqual({});

    const partial = route({ streaming: true });
    expect(partial.capabilities).toEqual({ streaming: true });

    for (const capabilities of [capabilitiesOf(), capabilitiesOf({})]) {
      expect(capabilities.streaming).not.toBe(false);
      expect(capabilities.srt).not.toBe(false);
      expect(capabilities.vtt).not.toBe(false);
      expect(capabilities.timestamps).not.toBe(false);
      expect(capabilities.url_input).not.toBe(false);
    }
  });

  test("a route with no capabilities still allows streaming, SRT, VTT, timestamps, and URL input", () => {
    for (const capabilities of [capabilitiesOf(), capabilitiesOf({})]) {
      expect(() =>
        requireAudioCapabilities(capabilities, request({ stream: true })),
      ).not.toThrow();
      expect(() =>
        requireAudioCapabilities(
          capabilities,
          request({ response_format: "srt" }),
        ),
      ).not.toThrow();
      expect(() =>
        requireAudioCapabilities(
          capabilities,
          request({ response_format: "vtt" }),
        ),
      ).not.toThrow();
      expect(() =>
        requireAudioCapabilities(
          capabilities,
          request({ timestamp_granularities: ["word"] }),
        ),
      ).not.toThrow();
      expect(() =>
        requireAudioCapabilities(
          capabilities,
          request({ url: "https://example.com/a.wav" }),
        ),
      ).not.toThrow();
    }
  });

  test("explicit false still rejects streaming, SRT, VTT, timestamps, and URL input", () => {
    const denied = capabilitiesOf({
      streaming: false,
      srt: false,
      vtt: false,
      timestamps: false,
      url_input: false,
    });

    expect(denied).toEqual({
      streaming: false,
      srt: false,
      vtt: false,
      timestamps: false,
      url_input: false,
    });

    expect(() =>
      requireAudioCapabilities(denied, request({ stream: true })),
    ).toThrow(AudioProviderCapabilityError);
    expect(() =>
      requireAudioCapabilities(denied, request({ response_format: "srt" })),
    ).toThrow(AudioProviderCapabilityError);
    expect(() =>
      requireAudioCapabilities(denied, request({ response_format: "vtt" })),
    ).toThrow(AudioProviderCapabilityError);
    expect(() =>
      requireAudioCapabilities(
        denied,
        request({ timestamp_granularities: ["segment"] }),
      ),
    ).toThrow(AudioProviderCapabilityError);
    expect(() =>
      requireAudioCapabilities(
        denied,
        request({ url: "https://example.com/a.wav" }),
      ),
    ).toThrow(AudioProviderCapabilityError);
  });
});
