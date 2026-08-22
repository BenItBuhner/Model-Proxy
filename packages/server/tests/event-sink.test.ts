import { afterEach, describe, expect, test } from "bun:test";

import {
  eventSink,
  type RequestEvent,
} from "../src/observability/event-sink.ts";
import {
  currentRequestId,
  emit,
  nowIso,
  runWithRequestContext,
} from "../src/observability/request-context.ts";

afterEach(() => {
  eventSink._resetForTests();
});

describe("eventSink", () => {
  test("start() is idempotent for the same requestId", () => {
    const a = eventSink.start("req-1");
    const b = eventSink.start("req-1");
    a.emit({ type: "request.started", at: nowIso(), protocol: "openai", endpoint: "/v1/chat/completions", model: "m", stream: false, enforceEnabled: false });
    const trace = eventSink.get("req-1");
    expect(trace?.events.length).toBe(1);
    // same underlying entry
    expect(typeof b.emit).toBe("function");
  });

  test("subscribe receives future events in order", () => {
    const events: RequestEvent[] = [];
    const unsub = eventSink.subscribe("req-sub", (e) => events.push(e));
    const emitter = eventSink.start("req-sub");
    emitter.emit({ type: "request.started", at: nowIso(), protocol: "openai", endpoint: "/v1/chat/completions", model: "m", stream: false, enforceEnabled: false });
    emitter.emit({ type: "request.finished", at: nowIso(), status: 200, totalMs: 42 });
    unsub();
    expect(events.map((e) => e.type)).toEqual([
      "request.started",
      "request.finished",
    ]);
  });

  test("get() returns undefined for unknown ids", () => {
    expect(eventSink.get("missing")).toBeUndefined();
  });

  test("drop() removes trace", () => {
    eventSink.start("drop-me");
    expect(eventSink.get("drop-me")).toBeDefined();
    eventSink.drop("drop-me");
    expect(eventSink.get("drop-me")).toBeUndefined();
  });

  test("subscribers fire for events emitted BEFORE subscribe only receive new ones", () => {
    const emitter = eventSink.start("order-1");
    emitter.emit({ type: "request.started", at: nowIso(), protocol: "openai", endpoint: "/v1/chat/completions", model: "m", stream: false, enforceEnabled: false });
    const fresh: RequestEvent[] = [];
    eventSink.subscribe("order-1", (e) => fresh.push(e));
    emitter.emit({ type: "request.finished", at: nowIso(), status: 200, totalMs: 1 });
    expect(fresh.length).toBe(1);
    expect(fresh[0]?.type).toBe("request.finished");
    // The backlog is separately readable via .get()
    expect(eventSink.get("order-1")?.events.length).toBe(2);
  });
});

describe("request-context (AsyncLocalStorage)", () => {
  test("emit() inside runWithRequestContext lands on the right trace", async () => {
    await runWithRequestContext("ctx-1", async () => {
      expect(currentRequestId()).toBe("ctx-1");
      emit({ type: "request.started", at: nowIso(), protocol: "openai", endpoint: "/v1/chat/completions", model: "m", stream: false, enforceEnabled: false });
      // Force an async boundary.
      await Promise.resolve();
      emit({ type: "request.finished", at: nowIso(), status: 200, totalMs: 5 });
    });
    const trace = eventSink.get("ctx-1");
    expect(trace?.finished).toBe(true);
    expect(trace?.events.map((e) => e.type)).toEqual([
      "request.started",
      "request.finished",
    ]);
  });

  test("emit() outside of a context is a no-op", () => {
    emit({ type: "request.finished", at: nowIso(), status: 200, totalMs: 1 });
    // No trace created
    expect(eventSink.size).toBe(0);
  });

  test("nested runWithRequestContext on same id reuses the underlying trace", async () => {
    await runWithRequestContext("nest", async () => {
      emit({ type: "request.started", at: nowIso(), protocol: "openai", endpoint: "/v1/chat/completions", model: "m", stream: true, enforceEnabled: false });
    });
    await runWithRequestContext("nest", async () => {
      emit({ type: "request.finished", at: nowIso(), status: 200, totalMs: 2 });
    });
    const trace = eventSink.get("nest");
    expect(trace?.events.length).toBe(2);
  });
});
