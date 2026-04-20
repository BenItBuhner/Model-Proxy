import { Hono } from "hono";

import { modelConfigLoader } from "../../config/model-loader.ts";
import { providerConfigLoader } from "../../config/provider-loader.ts";
import { isAuthConfigured } from "../auth.ts";

const startedAt = Date.now();

export function createHealthRoutes(): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.get("/health/detailed", (c) => {
    const models = modelConfigLoader.getAvailableModels();
    const providers = providerConfigLoader.getAvailableProviders();
    return c.json({
      status: "ok",
      uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
      auth_configured: isAuthConfigured(),
      models_count: models.length,
      providers_count: providers.length,
      models,
      providers,
      runtime: {
        bun: typeof Bun !== "undefined" ? Bun.version : undefined,
        platform: process.platform,
        arch: process.arch,
        node_env: process.env.NODE_ENV,
      },
    });
  });

  return app;
}
