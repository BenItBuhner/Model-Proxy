/** Minimal OpenAI-compatible client for the local proxy, with per-call timing and kernel trace capture. */

export interface ChatCallResult {
  ok: boolean;
  content: string;
  latencyMs: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  kernel?: Record<string, unknown>;
  error?: string;
  status?: number;
}

export interface ChatClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Sent as x-opencode-session so the kernel keeps a ledger per item. */
  sessionPrefix?: string;
  timeoutMs?: number;
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens?: number;
  /**
   * Stream upstream and assemble client-side. Required for plain base models
   * behind CDN origin timeouts (non-streaming generations >100s die with 524);
   * fusion models stream upstream internally and return `fusion_trace` only
   * on the non-streaming path, so leave this off for them.
   */
  stream?: boolean;
}

interface Assembled {
  content: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: string;
  /** Kernel summary from the trailing `: fusion-kernel {...}` SSE comment. */
  kernel?: Record<string, unknown>;
}

/** Abort a stream that produced no DATA event for this long; keep-alive comments do not count. */
const DATA_IDLE_MS = Number(process.env.KERNEL_BENCH_DATA_IDLE_MS ?? 600_000);

async function assembleSse(res: Response, abort: AbortController): Promise<Assembled> {
  if (res.body === null) return { content: "", error: "empty body" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let usage: Assembled["usage"];
  let error: string | undefined;
  let kernel: Assembled["kernel"];
  let lastData = performance.now();
  const idleTimer = setInterval(() => {
    if (performance.now() - lastData > DATA_IDLE_MS) {
      error = `stream idle: no data event for ${Math.round(DATA_IDLE_MS / 1000)}s (zombie keep-alive)`;
      abort.abort();
    }
  }, 5_000);
  const handle = (event: string) => {
    const comment = event.split("\n").find((l) => l.startsWith(": fusion-kernel "));
    if (comment !== undefined) {
      try {
        kernel = JSON.parse(comment.slice(": fusion-kernel ".length)) as Record<string, unknown>;
      } catch {
        // ignore malformed trace comment
      }
    }
    const line = event.split("\n").find((l) => l.startsWith("data:"));
    if (line === undefined) return;
    const payload = line.slice(5).trim();
    if (payload.length === 0 || payload === "[DONE]") return;
    lastData = performance.now();
    let chunk: Record<string, unknown>;
    try {
      chunk = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return;
    }
    if (chunk["error"] !== undefined) error = JSON.stringify(chunk["error"]).slice(0, 400);
    const delta = ((chunk["choices"] as Array<Record<string, unknown>> | undefined)?.[0]?.["delta"] ?? {}) as Record<string, unknown>;
    if (typeof delta["content"] === "string") content += delta["content"];
    const u = chunk["usage"] as Record<string, unknown> | undefined | null;
    if (u !== undefined && u !== null && typeof u === "object") {
      usage = { promptTokens: Number(u["prompt_tokens"] ?? 0), completionTokens: Number(u["completion_tokens"] ?? 0), totalTokens: Number(u["total_tokens"] ?? 0) };
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        handle(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
      }
    }
    if (buf.trim().length > 0) handle(buf);
  } catch (err) {
    if (error === undefined) error = err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(idleTimer);
  }
  return { content, usage, error, kernel };
}

export async function chatCall(
  opts: ChatClientOptions,
  model: string,
  messages: unknown[],
  sessionId: string,
): Promise<ChatCallResult> {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 1_200_000);
  try {
    const res = await fetch(`${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.apiKey}`,
        "content-type": "application/json",
        "x-opencode-session": `${opts.sessionPrefix ?? "bench"}-${sessionId}`,
        "x-opencode-request": `${opts.sessionPrefix ?? "bench"}-${sessionId}-${Date.now()}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(opts.reasoningEffort !== undefined ? { reasoning_effort: opts.reasoningEffort } : {}),
        ...(opts.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.stream === true ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
      signal: controller.signal,
    });
    if (opts.stream === true && res.ok && (res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      const assembled = await assembleSse(res, controller);
      const latencyMs = Math.round(performance.now() - started);
      const ok = assembled.content.length > 0 && assembled.error === undefined;
      return { ok, content: assembled.content, latencyMs, usage: assembled.usage, kernel: assembled.kernel, error: ok ? undefined : (assembled.error ?? "empty stream"), status: res.status };
    }
    const latencyMs = Math.round(performance.now() - started);
    const text = await res.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return { ok: false, content: "", latencyMs, error: `non-JSON response (${res.status}): ${text.slice(0, 300)}`, status: res.status };
    }
    if (!res.ok) {
      return { ok: false, content: "", latencyMs, error: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 500)}`, status: res.status };
    }
    const choice = (body["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
    const message = choice?.["message"] as Record<string, unknown> | undefined;
    const content = typeof message?.["content"] === "string" ? (message["content"] as string) : "";
    const usageObj = body["usage"] as Record<string, unknown> | undefined;
    const usage = usageObj !== undefined
      ? {
          promptTokens: Number(usageObj["prompt_tokens"] ?? 0),
          completionTokens: Number(usageObj["completion_tokens"] ?? 0),
          totalTokens: Number(usageObj["total_tokens"] ?? 0),
        }
      : undefined;
    const trace = body["fusion_trace"] as Record<string, unknown> | undefined;
    return {
      ok: content.length > 0,
      content,
      latencyMs,
      usage,
      kernel: trace?.["kernel"] as Record<string, unknown> | undefined,
      error: content.length > 0 ? undefined : "empty content",
      status: res.status,
    };
  } catch (err) {
    return { ok: false, content: "", latencyMs: Math.round(performance.now() - started), error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
