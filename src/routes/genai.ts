/**
 * Google GenAI / Gemini API routes.
 * Provides generateContent and streamGenerateContent endpoints.
 */
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { configLoader } from "../routing/config-loader.ts";
import { FallbackRouter } from "../routing/router.ts";
import {
  genaiToOpenaiRequest,
  openaiToGenaiResponse,
} from "../core/format-converters.ts";
import { formatGenaiError } from "../core/error-formatters.ts";
import { RoutingError } from "../types/routing.ts";

const app = new Hono();

// Non-streaming generate content
app.post("/v1/genai/generateContent", async (c) => {
  let body: Record<string, any>;
  try { body = await c.req.json(); } catch {
    return c.json(formatGenaiError(400, "Invalid JSON body"), 400);
  }

  const model = body.model;
  if (!model) return c.json(formatGenaiError(400, "model is required"), 400);

  try { configLoader.loadConfig(model); } catch {
    return c.json(formatGenaiError(400, `Model '${model}' not found`), 400);
  }

  const openaiRequest = genaiToOpenaiRequest(body);
  const router = new FallbackRouter();

  try {
    const openaiResponse = await router.callWithFallback(model, openaiRequest, "openai", false);
    const genaiResponse = openaiToGenaiResponse(openaiResponse, model);
    return c.json(genaiResponse);
  } catch (e: any) {
    if (e instanceof RoutingError) {
      return c.json(formatGenaiError(503, `All routes failed: ${e.getErrorSummary()}`), 503);
    }
    return c.json(formatGenaiError(500, `Error: ${e.message}`), 500);
  }
});

// Streaming generate content
app.post("/v1/genai/streamGenerateContent", async (c) => {
  let body: Record<string, any>;
  try { body = await c.req.json(); } catch {
    return c.json(formatGenaiError(400, "Invalid JSON body"), 400);
  }

  const model = body.model;
  if (!model) return c.json(formatGenaiError(400, "model is required"), 400);

  try { configLoader.loadConfig(model); } catch {
    return c.json(formatGenaiError(400, `Model '${model}' not found`), 400);
  }

  const openaiRequest = genaiToOpenaiRequest(body);
  openaiRequest.stream = true;
  const router = new FallbackRouter();

  return honoStream(c, async (stream) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");

    try {
      const gen = await router.callWithFallback(model, openaiRequest, "openai", true);

      for await (const rawChunk of gen) {
        for (const line of rawChunk.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") {
            if (payload === "[DONE]") await stream.write("data: [DONE]\n\n");
            continue;
          }
          try {
            const obj = JSON.parse(payload);
            // Convert OpenAI chunk to GenAI format
            const delta = obj.choices?.[0]?.delta;
            const parts: Record<string, any>[] = [];
            if (delta?.content) parts.push({ text: delta.content });
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  let args: Record<string, any> = {};
                  try { args = JSON.parse(tc.function.arguments || "{}"); } catch {}
                  parts.push({ functionCall: { name: tc.function.name, args } });
                }
              }
            }
            if (parts.length > 0) {
              const genaiChunk = {
                candidates: [{ content: { role: "model", parts }, index: 0 }],
              };
              await stream.write(`data: ${JSON.stringify(genaiChunk)}\n\n`);
            }
          } catch {}
        }
      }
    } catch (e: any) {
      await stream.write(`data: ${JSON.stringify(formatGenaiError(500, String(e)))}\n\n`);
    }
  });
});

export default app;
