/**
 * OpenAI-compatible API routes.
 * /v1/chat/completions and /v1/models endpoints.
 */
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";
import { configLoader } from "../routing/config-loader.ts";
import { FallbackRouter } from "../routing/router.ts";
import { formatOpenaiError } from "../core/error-formatters.ts";
import { RoutingError } from "../types/routing.ts";

const app = new Hono();

// List models
app.get("/v1/models", (c) => {
  try {
    const available = configLoader.getAvailableModels();
    const models = available.map((name) => {
      let owner = "unknown";
      try {
        const config = configLoader.loadConfig(name);
        if (config.model_routings.length > 0) owner = config.model_routings[0].provider;
      } catch {}
      return { id: name, object: "model", created: Math.floor(Date.now() / 1000), owned_by: owner };
    });
    return c.json({ object: "list", data: models });
  } catch (e: any) {
    return c.json(formatOpenaiError(500, `Error listing models: ${e.message}`), 500);
  }
});

// Chat completions
app.post("/v1/chat/completions", async (c) => {
  let body: Record<string, any>;
  try {
    body = await c.req.json();
  } catch {
    return c.json(formatOpenaiError(400, "Invalid JSON body"), 400);
  }

  const model = body.model;
  if (!model) return c.json(formatOpenaiError(400, "model is required"), 400);

  // Validate model exists
  try {
    configLoader.loadConfig(model);
  } catch {
    const available = configLoader.getAvailableModels();
    return c.json(formatOpenaiError(400,
      `Model '${model}' not found. Available: ${available.join(", ") || "none"}`,
      "invalid_request_error"
    ), 400);
  }

  const isStream = !!body.stream;
  const router = new FallbackRouter();

  if (isStream) {
    return honoStream(c, async (stream) => {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      c.header("Connection", "keep-alive");
      c.header("X-Accel-Buffering", "no");

      try {
        const gen = await router.callWithFallback(model, body, "openai", true);
        for await (const chunk of gen) {
          await stream.write(chunk);
        }
      } catch (e: any) {
        if (e instanceof RoutingError) {
          await stream.write(`data: ${JSON.stringify(formatOpenaiError(503, `All routes failed: ${e.getErrorSummary()}`, "service_unavailable"))}\n\n`);
        } else {
          await stream.write(`data: ${JSON.stringify(formatOpenaiError(500, `Streaming error: ${e.message}`))}\n\n`);
        }
        await stream.write("data: [DONE]\n\n");
      }
    });
  }

  try {
    const response = await router.callWithFallback(model, body, "openai", false);
    response.model = model; // Preserve client's model name
    return c.json(response);
  } catch (e: any) {
    if (e instanceof RoutingError) {
      return c.json(formatOpenaiError(503, `All routes failed for '${model}': ${e.getErrorSummary()}`, "service_unavailable"), 503);
    }
    return c.json(formatOpenaiError(500, `Error: ${e.message}`), 500);
  }
});

// Force-streaming variant
app.post("/v1/chat/completions/stream", async (c) => {
  let body: Record<string, any>;
  try { body = await c.req.json(); } catch { return c.json(formatOpenaiError(400, "Invalid JSON body"), 400); }
  body.stream = true;

  const model = body.model;
  if (!model) return c.json(formatOpenaiError(400, "model is required"), 400);

  try { configLoader.loadConfig(model); } catch {
    return c.json(formatOpenaiError(400, `Model '${model}' not found`, "invalid_request_error"), 400);
  }

  const router = new FallbackRouter();

  return honoStream(c, async (stream) => {
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache");
    c.header("Connection", "keep-alive");

    try {
      const gen = await router.callWithFallback(model, body, "openai", true);
      for await (const chunk of gen) await stream.write(chunk);
    } catch (e: any) {
      await stream.write(`data: ${JSON.stringify(formatOpenaiError(500, e.message))}\n\n`);
      await stream.write("data: [DONE]\n\n");
    }
  });
});

export default app;
