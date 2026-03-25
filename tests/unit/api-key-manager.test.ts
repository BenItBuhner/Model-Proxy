import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  getAvailableKeys,
  getApiKey,
  markKeyFailed,
  markProviderFailed,
  resetRotationState,
  resetFailedKeys,
  KeyCycleTracker,
} from "../../src/core/api-key-manager.ts";

describe("API Key Manager", () => {
  beforeEach(() => {
    resetRotationState();
    resetFailedKeys();
    // Clean up test env vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TESTPROV_")) delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("TESTPROV_")) delete process.env[key];
    }
    resetRotationState();
  });

  test("getAvailableKeys returns keys from env vars", () => {
    process.env.TESTPROV_API_KEY_1 = "key-a";
    process.env.TESTPROV_API_KEY_2 = "key-b";
    const keys = getAvailableKeys("testprov");
    expect(keys).toContain("key-a");
    expect(keys).toContain("key-b");
    expect(keys.length).toBe(2);
  });

  test("getAvailableKeys returns empty for unknown provider", () => {
    const keys = getAvailableKeys("nonexistent_provider_xyz");
    expect(keys.length).toBe(0);
  });

  test("getApiKey returns a key via round-robin", () => {
    process.env.TESTPROV_API_KEY_1 = "key-1";
    process.env.TESTPROV_API_KEY_2 = "key-2";
    const first = getApiKey("testprov");
    const second = getApiKey("testprov");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // Should rotate
    expect(first).not.toBe(second);
  });

  test("markKeyFailed puts key in cooldown", () => {
    process.env.TESTPROV_API_KEY_1 = "key-only";
    markKeyFailed("testprov", "key-only", undefined, 999);
    const key = getApiKey("testprov");
    expect(key).toBeNull();
  });

  test("markProviderFailed blocks all keys", () => {
    process.env.TESTPROV_API_KEY_1 = "key-1";
    process.env.TESTPROV_API_KEY_2 = "key-2";
    markProviderFailed("testprov", 999);
    expect(getApiKey("testprov")).toBeNull();
  });

  test("resetFailedKeys clears cooldowns", () => {
    process.env.TESTPROV_API_KEY_1 = "key-1";
    markKeyFailed("testprov", "key-1", undefined, 999);
    expect(getApiKey("testprov")).toBeNull();
    resetFailedKeys("testprov");
    expect(getApiKey("testprov")).toBe("key-1");
  });
});

describe("KeyCycleTracker", () => {
  beforeEach(() => {
    resetRotationState();
    resetFailedKeys();
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CYCLEPROV_")) delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CYCLEPROV_")) delete process.env[key];
    }
    resetRotationState();
  });

  test("cycles through keys", () => {
    process.env.CYCLEPROV_API_KEY_1 = "ck-1";
    process.env.CYCLEPROV_API_KEY_2 = "ck-2";

    const tracker = new KeyCycleTracker({ provider: "cycleprov", maxCycles: 1 });
    const keys: string[] = [];
    let key = tracker.getNextKey();
    while (key) {
      keys.push(key);
      key = tracker.getNextKey();
    }
    expect(keys.length).toBe(2);
    expect(keys).toContain("ck-1");
    expect(keys).toContain("ck-2");
  });

  test("exhausted returns true when no keys", () => {
    const tracker = new KeyCycleTracker({ provider: "noprov" });
    expect(tracker.exhausted()).toBe(true);
    expect(tracker.getNextKey()).toBeNull();
  });

  test("markFailed puts key in cooldown", () => {
    process.env.CYCLEPROV_API_KEY_1 = "ck-1";
    const tracker = new KeyCycleTracker({ provider: "cycleprov", maxCycles: 2, routeCooldown: 999 });
    const key = tracker.getNextKey();
    expect(key).toBe("ck-1");
    tracker.markFailed("ck-1", "model_key_failure");
    // After marking failed, next key should be null (only 1 key, now in cooldown)
    // But within the same tracker, cooldown is bypassed for already-attempted keys
    // After cycle reset, it should still be available within the same request
    const next = tracker.getNextKey();
    // With 1 key and max 2 cycles, after trying once and failing, should exhaust
    expect(tracker.exhausted()).toBe(true);
  });

  test("allKeysInCooldown detects global cooldown", () => {
    process.env.CYCLEPROV_API_KEY_1 = "ck-1";
    markProviderFailed("cycleprov", 999);
    const tracker = new KeyCycleTracker({ provider: "cycleprov" });
    expect(tracker.allKeysInCooldown()).toBe(true);
  });
});
