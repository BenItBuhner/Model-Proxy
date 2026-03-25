/**
 * Open Responses API routes.
 * POST /v1/responses - Create a response in the Open Responses format.
 */
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { configLoader } from "../routing/config-loader.ts";
import { FallbackRouter } from "../routing/router.ts";
import {
  responsesToOpenaiRequest,
  openaiToResponsesResponse,
} from "../core/format-converters.ts";
import { formatResponsesError } from "../core/error-formatters.ts";
import { RoutingError } from "../types/routing.ts";

const app = new Hono();

app.post("/v1/responses", async (c) => {
  let body: Record<string, any>;
  try { body = await c.req.json(); } catch {
    return c.json(formatResponsesError(400, "Invalid JSON body"), 400);
  }

  const model = body.model;
  if (!model) return c.json(formatResponsesError(400, "model is required"), 400);

  try { configLoader.loadConfig(model); } catch {
    const available = configLoader.getAvailableModels();
    return c.json(formatResponsesError(400,
      `Model '${model}' not found. Available: ${available.join(", ") || "none"}`,
      "invalid_request_error"
    ), 400);
  }

  // Convert Responses format to OpenAI format for internal routing
  const openaiRequest = responsesToOpenaiRequest(body);
  const isStream = !!body.stream;
  const router = new FallbackRouter();

  if (isStream) {
    return honoStream(c, async (stream) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");

      const respId = `resp_${Date.now().toString(36)}`;
      const msgId = `msg_${Date.now().toString(36)}`;
      const now = Math.floor(Date.now() / 1000);

      // Emit response.created
      await stream.write(`event: response.created\ndata: ${JSON.stringify({
        type: "response.created",
        response: { id: respId, object: "response", created_at: now, model, status: "in_progress", output: [] },
      })}\n\n`);

      // Emit response.in_progress
      await stream.write(`event: response.in_progress\ndata: ${JSON.stringify({
        type: "response.in_progress",
        response: { id: respId, object: "response", created_at: now, model, status: "in_progress", output: [] },
      })}\n\n`);

      try {
        const gen = await router.callWithFallback(model, openaiRequest, "openai", true);

        // Emit output_text deltas from OpenAI SSE chunks
        let outputIndex = 0;
        let contentIndex = 0;
        let fullText = "";

        for await (const rawChunk of gen) {
          for (const line of rawChunk.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed?.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            try {
              const obj = JSON.parse(payload);
              const delta = obj.choices?.[0]?.delta;
              if (delta?.content) {
                fullText += delta.content;
                await stream.write(`event: response.output_text.delta\ndata: ${JSON.stringify({
                  type: "response.output_text.delta",
                  item_id: msgId,
                  output_index: outputIndex,
                  content_index: contentIndex,
                  delta: delta.content,
                })}\n\n`);
              }
            } catch {}
          }
        }

        // Emit response.output_text.done
        await stream.write(`event: response.output_text.done\ndata: ${JSON.stringify({
          type: "response.output_text.done",
          item_id: msgId,
          output_index: outputIndex,
          content_index: contentIndex,
          text: fullText,
        })}\n\n`);

        // Emit response.completed
        await stream.write(`event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: respId, object: "response", created_at: now, model,
            status: "completed",
            output: [{
              type: "message", id: msgId, role: "assistant", status: "completed",
              content: [{ type: "output_text", text: fullText, annotations: [] }],
            }],
          },
        })}\n\n`);
      } catch (e: any) {
        await stream.write(`event: error\ndata: ${JSON.stringify({
          type: "error", error: { message: String(e), type: "server_error" },
        })}\n\n`);
      }
    });
  }

  // Non-streaming
  try {
    const openaiResponse = await router.callWithFallback(model, openaiRequest, "openai", false);
    const responsesResponse = openaiToResponsesResponse(openaiResponse, model);
    return c.json(responsesResponse);
  } catch (e: any) {
    if (e instanceof RoutingError) {
      return c.json(formatResponsesError(503, `All routes failed: ${e.getErrorSummary()}`), 503);
    }
    return c.json(formatResponsesError(500, `Error: ${e.message}`), 500);
  }
});

export default app;
