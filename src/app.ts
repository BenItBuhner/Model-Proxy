/**
 * Hono application setup - mounts all routes and middleware.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { authMiddleware } from "./middleware/auth.ts";
import { loggingMiddleware } from "./middleware/logging.ts";
import { env } from "./core/env.ts";
import { join } from "path";

// Import route modules
import healthRoutes from "./routes/health.ts";
import openaiRoutes from "./routes/openai.ts";
import anthropicRoutes from "./routes/anthropic.ts";
import responsesRoutes from "./routes/responses.ts";
import genaiRoutes from "./routes/genai.ts";
import setupApiRoutes from "./routes/setup/api.ts";

export function createApp(): Hono {
  const app = new Hono();

  // ── CORS ────────────────────────────────────────────────────────
  const origins = env.CORS_ORIGINS.split(",").map((o) => o.trim());
  app.use("*", cors({
    origin: origins.includes("*") ? "*" : origins,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    credentials: true,
  }));

  // ── Logging ─────────────────────────────────────────────────────
  app.use("*", loggingMiddleware);

  // ── Auth (skip health and static) ───────────────────────────────
  app.use("/v1/*", authMiddleware);
  app.use("/setup/api/*", authMiddleware);

  // ── API Routes ──────────────────────────────────────────────────
  app.route("/", healthRoutes);
  app.route("/", openaiRoutes);
  app.route("/", anthropicRoutes);
  app.route("/", responsesRoutes);
  app.route("/", genaiRoutes);

  // ── Setup UI ────────────────────────────────────────────────────
  app.route("/setup", setupApiRoutes);

  // Serve static UI files
  const uiDir = join(import.meta.dir, "ui");
  app.get("/setup", async (c) => {
    try {
      const file = Bun.file(join(uiDir, "index.html"));
      if (await file.exists()) {
        return c.html(await file.text());
      }
    } catch {}
    return c.text("Setup UI not found", 404);
  });

  app.get("/setup/static/*", serveStatic({ root: "./src/ui", rewriteRequestPath: (path) => path.replace("/setup/static", "") }));

  // ── Root redirect ───────────────────────────────────────────────
  app.get("/", (c) => c.json({
    name: "Model-Proxy",
    version: "1.0.0",
    description: "Multi-provider LLM inference proxy",
    endpoints: {
      openai: "/v1/chat/completions",
      anthropic: "/v1/messages",
      responses: "/v1/responses",
      genai: "/v1/genai/generateContent",
      models: "/v1/models",
      health: "/health",
      setup: "/setup",
    },
  }));

  return app;
}
