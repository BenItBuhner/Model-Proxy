import { describe, expect, test } from "bun:test";

import {
  getRequestLifetimeStats,
  recordRequestFinish,
  recordRequestStart,
  routeFinishFields,
} from "../src/server/request-log.ts";

describe("request-log", () => {
  test("tracks lifetime response counts since process start", () => {
    const before = getRequestLifetimeStats();
    recordRequestStart({
      requestId: "req-ok",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "test-model",
      isStreaming: false,
      enforceMode: false,
    });
    recordRequestFinish({
      requestId: "req-ok",
      responseStatus: 200,
      responseTimeMs: 12,
      resolvedProvider: "nvidia",
      resolvedModel: "minimax-m3",
    });
    recordRequestStart({
      requestId: "req-err",
      endpoint: "/v1/chat/completions",
      method: "POST",
      requestedModel: "test-model",
      isStreaming: false,
      enforceMode: false,
    });
    recordRequestFinish({
      requestId: "req-err",
      responseStatus: 502,
      responseTimeMs: 8,
    });

    const after = getRequestLifetimeStats();
    expect(after.requests_started).toBe(before.requests_started + 2);
    expect(after.requests_finished).toBe(before.requests_finished + 2);
    expect(after.responses_ok).toBe(before.responses_ok + 1);
    expect(after.responses_error).toBe(before.responses_error + 1);
    expect(after.inflight).toBe(before.inflight);
  });

  test("routeFinishFields copies winning provider/model", () => {
    expect(
      routeFinishFields({ provider: "opencode", model: "minimax-m3" }),
    ).toEqual({
      resolvedProvider: "opencode",
      resolvedModel: "minimax-m3",
    });
  });
});
