import { AsyncLocalStorage } from "node:async_hooks";

import { eventSink, type Emitter, type RequestEvent } from "./event-sink.ts";

interface RequestContext {
  requestId: string;
  emitter: Emitter;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Runs `fn` under a request-scoped AsyncLocalStorage context that carries
 * the requestId and an `Emitter` bound to that request's trace. Any code
 * inside `fn` (including nested awaits) can call `emit(...)` or read
 * `currentRequestId()` without explicit plumbing.
 */
export function runWithRequestContext<T>(
  requestId: string,
  fn: (ctx: RequestContext) => T,
): T {
  const ctx: RequestContext = {
    requestId,
    emitter: eventSink.start(requestId),
  };
  return storage.run(ctx, () => fn(ctx));
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

export function currentEmitter(): Emitter | undefined {
  return storage.getStore()?.emitter;
}

/**
 * Emit a request-scoped event. Safe to call from any async depth. A no-op
 * when there is no active request context (e.g. CLI scripts or tests that
 * do not wrap their flow in `runWithRequestContext`).
 */
export function emit(event: RequestEvent): void {
  const emitter = currentEmitter();
  if (emitter === undefined) return;
  emitter.emit(event);
}

export function nowIso(): string {
  return new Date().toISOString();
}
