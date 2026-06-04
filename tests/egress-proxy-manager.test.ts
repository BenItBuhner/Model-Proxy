import { afterEach, describe, expect, test } from "bun:test";

import {
  ProxyCycleTracker,
  parseEgressProxies,
  resetProxyState,
} from "../src/providers/egress-proxy-manager.ts";
import { parseRetryAfterFromErrorBody } from "../src/providers/upstream-fetch.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  resetProxyState();
});

describe("parseRetryAfterFromErrorBody", () => {
  test("detects FreeUsageLimitError metadata retryAfter", () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "FreeUsageLimitError", message: "limit exceeded" },
      metadata: { retryAfter: 3600 },
    });
    expect(parseRetryAfterFromErrorBody(body)).toBe(3600);
  });

  test("returns undefined for unrelated errors", () => {
    expect(parseRetryAfterFromErrorBody('{"error":"nope"}')).toBeUndefined();
  });
});

describe("ProxyCycleTracker", () => {
  test("rotates through configured egress proxies", () => {
    process.env.OPENCODE_EGRESS_PROXY_1 = "http://proxy-a:8080";
    process.env.OPENCODE_EGRESS_PROXY_2 = "http://proxy-b:8080";

    const tracker = new ProxyCycleTracker({
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      maxCycles: 1,
    });

    const first = tracker.getNextProxy();
    const second = tracker.getNextProxy();
    expect(first?.url).toBe("http://proxy-a:8080");
    expect(second?.url).toBe("http://proxy-b:8080");
  });

  test("skips cooled-down proxies", () => {
    process.env.OPENCODE_EGRESS_PROXY_1 = "http://proxy-a:8080";
    process.env.OPENCODE_EGRESS_PROXY_2 = "http://proxy-b:8080";

    const tracker = new ProxyCycleTracker({
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      maxCycles: 2,
    });

    const first = tracker.getNextProxy();
    expect(first?.url).toBe("http://proxy-a:8080");
    tracker.markFailed(first!.url, { cooldownSeconds: 86400 });

    const second = tracker.getNextProxy();
    expect(second?.url).toBe("http://proxy-b:8080");
  });
});

describe("parseEgressProxies", () => {
  test("reads OPENCODE_EGRESS_PROXY env patterns", () => {
    process.env.OPENCODE_EGRESS_PROXY = "http://direct-proxy:3128";
    const proxies = parseEgressProxies("opencode");
    expect(proxies.some((p) => p.url === "http://direct-proxy:3128")).toBe(true);
  });
});
