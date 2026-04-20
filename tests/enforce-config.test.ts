import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveEnforceConfig } from "../src/routing/enforce/config.ts";

const ENV_KEYS = [
  "ENFORCE_TOOL_CALL_MODE",
  "TOOL_CALL_TERMINATION_FLAG",
  "TOOL_CALL_MAX_RETRIES",
  "TOOL_CALL_INJECTION_GUIDANCE",
  "STREAM_CHUNK_DELAY",
  "EMPTY_RESPONSE_POLICY",
];

let snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot = {};
  for (const key of ENV_KEYS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("resolveEnforceConfig precedence", () => {
  test("env defaults: enabled=false, default flag, 10 retries", () => {
    const config = resolveEnforceConfig(undefined, {});
    expect(config.enabled).toBe(false);
    expect(config.terminationFlag).toBe('{"tool_loop":"completed"}');
    expect(config.maxRetries).toBe(10);
    expect(config.emptyResponsePolicy).toBe("strict");
  });

  test("env override is picked up", () => {
    process.env.ENFORCE_TOOL_CALL_MODE = "true";
    process.env.TOOL_CALL_MAX_RETRIES = "5";
    const config = resolveEnforceConfig(undefined, {});
    expect(config.enabled).toBe(true);
    expect(config.maxRetries).toBe(5);
  });

  test("per-model overrides env", () => {
    process.env.ENFORCE_TOOL_CALL_MODE = "true";
    const config = resolveEnforceConfig(
      { enabled: false, max_retries: 3, termination_flag: "STOPSTOP" },
      {},
    );
    expect(config.enabled).toBe(false);
    expect(config.maxRetries).toBe(3);
    expect(config.terminationFlag).toBe("STOPSTOP");
  });

  test("query param overrides per-model", () => {
    const config = resolveEnforceConfig(
      { enabled: true },
      { query: "false" },
    );
    expect(config.enabled).toBe(false);
  });

  test("header overrides query", () => {
    const config = resolveEnforceConfig(
      { enabled: false },
      { header: "true", query: "false" },
    );
    expect(config.enabled).toBe(true);
  });

  test("max_retries clamps to [1,50]", () => {
    const hi = resolveEnforceConfig({ max_retries: 999 }, {});
    expect(hi.maxRetries).toBe(50);
  });

  test("invalid header value falls through to lower precedence", () => {
    const config = resolveEnforceConfig(
      { enabled: true },
      { header: "potato" },
    );
    expect(config.enabled).toBe(true);
  });

  test("empty_response_policy honors lenient override", () => {
    const config = resolveEnforceConfig(
      { empty_response_policy: "lenient" },
      {},
    );
    expect(config.emptyResponsePolicy).toBe("lenient");
  });
});
