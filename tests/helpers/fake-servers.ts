/**
 * Fake upstream API servers for integration testing.
 * Simulates OpenAI, Anthropic, and GenAI endpoints with configurable behavior.
 */
import type { Server } from "bun";

export interface FakeServerConfig {
  validApiKeys?: string[];
  defaultModel?: string;
  latencyMs?: number;
  failEveryN?: number;
  errorStatus?: number;
  responseContent?: string;
}

let _requestCount = 0;

function makeOpenAIResponse(model: string, content: string) {
  return {
    id: `chatcmpl-test-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

function makeOpenAIStreamChunks(model: string, content: string): string[] {
  const words = content.split(" ");
  const chunks: string[] = [];
  for (const word of words) {
    const chunk = {
      id: `chatcmpl-test-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { content: word + " " }, finish_reason: null }],
    };
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  // Final chunk with finish_reason
  chunks.push(`data: ${JSON.stringify({
    id: `chatcmpl-test-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

function makeAnthropicResponse(model: string, content: string) {
  return {
    id: `msg-test-${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: content }],
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function validateApiKey(req: Request, validKeys?: string[]): number | null {
  if (!validKeys || validKeys.length === 0) return null;
  const auth = req.headers.get("Authorization") || "";
  const xKey = req.headers.get("x-api-key") || "";
  let key = "";
  if (auth) {
    key = auth.replace(/^bearer\s+/i, "").trim();
  } else if (xKey) {
    key = xKey.trim();
  }
  if (!validKeys.includes(key)) return 401;
  return null;
}

/** Start a fake OpenAI-compatible server. */
export function startFakeOpenAI(config: FakeServerConfig = {}): Server {
  const content = config.responseContent || "Hello from fake OpenAI!";
  const validKeys = config.validApiKeys;
  const latency = config.latencyMs || 0;
  const failEveryN = config.failEveryN || 0;
  const errorStatus = config.errorStatus;

  return Bun.serve({
    port: 0, // Random available port
    async fetch(req) {
      _requestCount++;

      // Auth check
      const authError = validateApiKey(req, validKeys);
      if (authError) {
        return Response.json({ error: { message: "Invalid API key", type: "authentication_error" } }, { status: 401 });
      }

      // Configured error
      if (errorStatus) {
        return Response.json({ error: { message: "Configured error", type: "server_error" } }, { status: errorStatus });
      }

      // Intermittent failure
      if (failEveryN > 0 && _requestCount % failEveryN === 0) {
        return Response.json({ error: { message: "Intermittent failure", type: "server_error" } }, { status: 500 });
      }

      if (latency > 0) await new Promise(r => setTimeout(r, latency));

      const url = new URL(req.url);

      // Models list
      if (url.pathname === "/v1/models" && req.method === "GET") {
        return Response.json({ object: "list", data: [{ id: "test-model", object: "model", created: 0, owned_by: "test" }] });
      }

      // Chat completions
      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        const body = await req.json() as Record<string, any>;
        const model = body.model || config.defaultModel || "test-model";

        if (body.stream) {
          const chunks = makeOpenAIStreamChunks(model, content);
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            async start(controller) {
              for (const chunk of chunks) {
                controller.enqueue(encoder.encode(chunk));
                await new Promise(r => setTimeout(r, 5)); // Small delay between chunks
              }
              controller.close();
            }
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
          });
        }

        return Response.json(makeOpenAIResponse(model, content));
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
}

/** Start a fake Anthropic server. */
export function startFakeAnthropic(config: FakeServerConfig = {}): Server {
  const content = config.responseContent || "Hello from fake Anthropic!";
  const validKeys = config.validApiKeys;
  const latency = config.latencyMs || 0;
  const errorStatus = config.errorStatus;

  return Bun.serve({
    port: 0,
    async fetch(req) {
      const authError = validateApiKey(req, validKeys);
      if (authError) {
        return Response.json({ error: { message: "Invalid API key", type: "authentication_error" } }, { status: 401 });
      }

      if (errorStatus) {
        return Response.json({ error: { message: "Configured error", type: "server_error" } }, { status: errorStatus });
      }

      if (latency > 0) await new Promise(r => setTimeout(r, latency));

      const url = new URL(req.url);

      if (url.pathname === "/v1/messages" && req.method === "POST") {
        const body = await req.json() as Record<string, any>;
        const model = body.model || "test-model";

        if (body.stream) {
          const encoder = new TextEncoder();
          const events = [
            `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg-test", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } })}\n\n`,
            `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ];
          const stream = new ReadableStream({
            async start(controller) {
              for (const e of events) {
                controller.enqueue(encoder.encode(e));
                await new Promise(r => setTimeout(r, 5));
              }
              controller.close();
            }
          });
          return new Response(stream, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        return Response.json(makeAnthropicResponse(model, content));
      }

      return Response.json({ error: "Not found" }, { status: 404 });
    },
  });
}

export function resetRequestCount() { _requestCount = 0; }
export function getRequestCount() { return _requestCount; }
