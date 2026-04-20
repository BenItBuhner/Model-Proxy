"use client";

import { apiFetch, getStoredApiKey } from "./api";
import type { RequestEvent } from "./test-events";

export type Protocol = "openai" | "anthropic";

/**
 * Generate a deterministic short request id. Prefixed so it's visually
 * distinct from inbound UUIDs in logs.
 */
export function generateRequestId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `test-${hex}`;
}

export interface EventStreamHandle {
  close(): void;
  readonly requestId: string;
}

/**
 * Open a Server-Sent Events connection to `/v1/admin/events/:requestId/stream`.
 * Browsers' native `EventSource` does not support custom headers so we can't
 * attach a bearer directly — the proxy accepts the admin session cookie,
 * which the browser attaches automatically.
 *
 * Returns a handle whose `close()` tears down the connection. `onEvent` fires
 * for each parsed event. `onError` fires on connection error and `onDone` fires
 * once after the server sends `request.finished` (or on a hard close).
 */
export function openEventStream(
  requestId: string,
  handlers: {
    onEvent: (event: RequestEvent) => void;
    onDone?: () => void;
    onError?: (err: Event) => void;
  },
): EventStreamHandle {
  const url = `/v1/admin/events/${encodeURIComponent(requestId)}/stream`;
  const source = new EventSource(url, { withCredentials: true });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      source.close();
    } catch {
      // already closed
    }
    handlers.onDone?.();
  };

  source.onmessage = (message) => {
    if (closed) return;
    try {
      const parsed = JSON.parse(message.data) as RequestEvent;
      handlers.onEvent(parsed);
      if (parsed.type === "request.finished") close();
    } catch {
      // ignore malformed frames
    }
  };
  source.onerror = (event) => {
    if (closed) return;
    handlers.onError?.(event);
    close();
  };

  return {
    close,
    requestId,
  };
}

// --- Dispatch helpers -------------------------------------------------------

export interface DispatchOptions {
  requestId: string;
  protocol: Protocol;
  body: Record<string, unknown>;
  /** "default" leaves the header unset; true/false override per-request. */
  enforceOverride?: "default" | "force-on" | "force-off";
  signal?: AbortSignal;
}

export interface DispatchResult {
  response: Record<string, unknown>;
  status: number;
  requestId: string;
}

/**
 * Non-streaming dispatch. Returns the parsed JSON body (success or error
 * envelope) plus the HTTP status code.
 */
export async function dispatchNonStreaming(
  options: DispatchOptions,
): Promise<DispatchResult> {
  const { requestId, protocol, body, enforceOverride = "default", signal } = options;
  const path = protocol === "openai" ? "/v1/chat/completions" : "/v1/messages";
  const apiKey = getStoredApiKey();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": requestId,
  };
  if (apiKey !== undefined) headers["Authorization"] = `Bearer ${apiKey}`;
  if (enforceOverride === "force-on") headers["x-enforce-tool-call"] = "true";
  if (enforceOverride === "force-off") headers["x-enforce-tool-call"] = "false";

  const init: RequestInit = {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(body),
  };
  if (signal !== undefined) init.signal = signal;

  const res = await fetch(path, init);
  let parsed: unknown = undefined;
  const text = await res.text();
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }
  return {
    response: (parsed ?? {}) as Record<string, unknown>,
    status: res.status,
    requestId,
  };
}

/**
 * Streaming dispatch: yields raw SSE frames as the proxy sends them. The
 * caller is responsible for parsing chunks back into an assistant message.
 */
export async function* dispatchStreaming(
  options: DispatchOptions,
): AsyncGenerator<string, { status: number }, unknown> {
  const { requestId, protocol, body, enforceOverride = "default", signal } = options;
  const path = protocol === "openai" ? "/v1/chat/completions" : "/v1/messages";
  const apiKey = getStoredApiKey();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-request-id": requestId,
    accept: "text/event-stream",
  };
  if (apiKey !== undefined) headers["Authorization"] = `Bearer ${apiKey}`;
  if (enforceOverride === "force-on") headers["x-enforce-tool-call"] = "true";
  if (enforceOverride === "force-off") headers["x-enforce-tool-call"] = "false";

  const streamBody = { ...body, stream: true };
  const init: RequestInit = {
    method: "POST",
    headers,
    credentials: "include",
    body: JSON.stringify(streamBody),
  };
  if (signal !== undefined) init.signal = signal;

  const res = await fetch(path, init);
  if (res.body === null) {
    return { status: res.status };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (chunk.length > 0) yield chunk;
        idx = buffer.indexOf("\n\n");
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
  return { status: res.status };
}

// Re-export for convenience.
export { apiFetch };
