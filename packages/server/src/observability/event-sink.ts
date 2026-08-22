/**
 * Per-request event sink. Bounded LRU keyed by requestId, with fan-out
 * subscribers for SSE. Zero disk, zero completion content stored — only
 * structural metadata about what the router did.
 *
 * Event wire shapes live in `@model-proxy/contracts` so the web UI consumes
 * the exact same types.
 */

import type {
  RequestEvent,
  RequestTrace,
} from "@model-proxy/contracts/api/events.ts";

export type {
  RequestEvent,
  RequestEventType,
  RequestTrace,
} from "@model-proxy/contracts/api/events.ts";

type Subscriber = (event: RequestEvent) => void;

/**
 * Emitter returned by `eventSink.start()`. The router/enforce code emits
 * through this; the SSE endpoint subscribes to one of these.
 */
export interface Emitter {
  readonly requestId: string;
  emit(event: RequestEvent): void;
  finish(): void;
  isFinished(): boolean;
}

interface Entry {
  trace: RequestTrace;
  subscribers: Set<Subscriber>;
  lastTouchedAt: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MAX_TRACES = envInt("REQUEST_EVENT_MAX_TRACES", 200);
const MAX_EVENTS_PER_TRACE = envInt("REQUEST_EVENT_MAX_PER_TRACE", 500);

// Insertion-ordered map — JS Map iterates in insert order, giving us LRU-ish
// eviction when we touch entries by deleting + re-setting on access.
const traces = new Map<string, Entry>();

function touch(requestId: string): Entry | undefined {
  const entry = traces.get(requestId);
  if (entry === undefined) return undefined;
  entry.lastTouchedAt = Date.now();
  traces.delete(requestId);
  traces.set(requestId, entry);
  return entry;
}

function evictIfNeeded(): void {
  while (traces.size > MAX_TRACES) {
    const oldestKey = traces.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = traces.get(oldestKey);
    if (entry !== undefined) {
      // Fire a synthetic close signal to any lingering subscribers so SSE
      // connections don't leak when an entry gets evicted mid-flight.
      for (const sub of entry.subscribers) {
        try {
          sub({
            type: "request.finished",
            at: new Date().toISOString(),
            status: 0,
            totalMs: 0,
            errorType: "TraceEvicted",
            errorMessage: "Trace dropped due to capacity",
          });
        } catch {
          // ignore subscriber errors on eviction
        }
      }
    }
    traces.delete(oldestKey);
  }
}

function startTrace(requestId: string): Entry {
  const existing = touch(requestId);
  if (existing !== undefined) return existing;
  const entry: Entry = {
    trace: {
      requestId,
      startedAt: Date.now(),
      finished: false,
      events: [],
    },
    subscribers: new Set<Subscriber>(),
    lastTouchedAt: Date.now(),
  };
  traces.set(requestId, entry);
  evictIfNeeded();
  return entry;
}

function pushEvent(entry: Entry, event: RequestEvent): void {
  if (entry.trace.events.length >= MAX_EVENTS_PER_TRACE) return;
  entry.trace.events.push(event);
  if (event.type === "request.finished") entry.trace.finished = true;
  entry.lastTouchedAt = Date.now();
  for (const sub of entry.subscribers) {
    try {
      sub(event);
    } catch {
      // ignore bad subscribers
    }
  }
}

function makeEmitter(entry: Entry, requestId: string): Emitter {
  let finished = false;
  return {
    requestId,
    emit(event) {
      if (finished && event.type !== "request.finished") return;
      pushEvent(entry, event);
      if (event.type === "request.finished") finished = true;
    },
    finish() {
      finished = true;
    },
    isFinished() {
      return finished;
    },
  };
}

export const eventSink = {
  /** Begin (or resume) a trace for `requestId` and return an Emitter. */
  start(requestId: string): Emitter {
    const entry = startTrace(requestId);
    return makeEmitter(entry, requestId);
  },

  /** Snapshot of a trace, or undefined if unknown. */
  get(requestId: string): RequestTrace | undefined {
    const entry = touch(requestId);
    return entry?.trace;
  },

  /**
   * Subscribe to future events on `requestId`. If the trace does not yet
   * exist, a placeholder is created so early subscribers don't miss anything.
   * Returns an unsubscribe function.
   */
  subscribe(requestId: string, cb: Subscriber): () => void {
    const entry = startTrace(requestId);
    entry.subscribers.add(cb);
    return () => {
      entry.subscribers.delete(cb);
    };
  },

  /** Drop a trace and close all subscribers. */
  drop(requestId: string): void {
    traces.delete(requestId);
  },

  /** Test helper: clear everything. */
  _resetForTests(): void {
    traces.clear();
  },

  get size(): number {
    return traces.size;
  },
};
