import { describe, expect, test } from "bun:test";

import {
  legacyErrorActionMapping,
  normalizeModel,
  normalizeProvider,
} from "../src/config/bundle-normalizer.ts";

describe("bundle-normalizer", () => {
  test("maps legacy error_handling actions to canonical names", () => {
    const raw = {
      name: "local-llama",
      error_handling: {
        "401": { action: "ignore" },
        "429": { action: "cooldown", cooldown_seconds: 60 },
        "500": { action: "retry" },
      },
    };
    const { normalized, changes } = normalizeProvider(raw);

    const handled = (normalized as { error_handling: Record<string, { action: string }> })
      .error_handling;
    expect(handled["401"]!.action).toBe("pass_through");
    expect(handled["429"]!.action).toBe("provider_cooldown");
    expect(handled["500"]!.action).toBe("retry");

    expect(changes.map((c) => c.path).sort()).toEqual(
      ["error_handling.401.action", "error_handling.429.action"].sort(),
    );
    for (const c of changes) {
      expect(c.kind).toBe("provider");
      expect(c.name).toBe("local-llama");
    }
  });

  test("preserves canonical values and enum-accepted aliases without rewriting", () => {
    const raw = {
      name: "gemini",
      authentication: { type: "api_key", header_name: "Authorization" },
      endpoints: {
        base_url: "https://example.com",
        completions: "/v1/chat",
        compatible_format: "azure",
      },
      error_handling: { "401": { action: "global_key_failure" } },
    };
    const { normalized, changes } = normalizeProvider(raw);
    expect(changes).toEqual([]);
    expect((normalized as { authentication: { type: string } }).authentication.type).toBe(
      "api_key",
    );
    expect(
      (normalized as { endpoints: { compatible_format: string } }).endpoints.compatible_format,
    ).toBe("azure");
  });

  test("does not mutate the input object", () => {
    const raw = {
      name: "x",
      error_handling: { "500": { action: "ignore" } },
    };
    const snapshot = JSON.stringify(raw);
    normalizeProvider(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
  });

  test("strips Python-only provider_notes diagnostic block", () => {
    const raw = {
      name: "p",
      provider_notes: { description: "old junk" },
    };
    const { normalized } = normalizeProvider(raw);
    expect("provider_notes" in normalized).toBe(false);
  });

  test("model normalizer is a safe no-op today", () => {
    const raw = { logical_name: "m", model_routings: [{ provider: "a", model: "b" }] };
    const { normalized, changes } = normalizeModel(raw);
    expect(normalized).toEqual(raw);
    expect(changes).toEqual([]);
  });

  test("legacyErrorActionMapping exposes every known legacy action", () => {
    const table = legacyErrorActionMapping();
    expect(table["ignore"]).toBe("pass_through");
    expect(table["cooldown"]).toBe("provider_cooldown");
  });
});
