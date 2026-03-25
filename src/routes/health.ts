/**
 * Health check endpoints.
 */
import { Hono } from "hono";
import { getAvailableKeys } from "../core/api-key-manager.ts";
import { getAllProviderConfigs } from "../core/provider-config.ts";
import { configLoader } from "../routing/config-loader.ts";

const app = new Hono();
const _startTime = Date.now();

app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health/detailed", (c) => {
  const providers: Record<string, any> = {};
  try {
    const configs = getAllProviderConfigs();
    for (const [name] of configs) {
      const keys = getAvailableKeys(name);
      providers[name] = { status: keys.length > 0 ? "healthy" : "no_keys", keys_available: keys.length };
    }
  } catch (e: any) {
    providers._error = String(e);
  }

  let modelConfig: Record<string, any>;
  try {
    const models = configLoader.getAvailableModels();
    modelConfig = { status: "healthy", models_count: models.length };
  } catch (e: any) {
    modelConfig = { status: "unhealthy", error: String(e) };
  }

  const uptimeSeconds = Math.floor((Date.now() - _startTime) / 1000);

  // Determine overall status
  const providerValues = Object.values(providers);
  const hasUnhealthy = providerValues.some((p: any) => p.status === "unhealthy");
  const allNoKeys = providerValues.every((p: any) => p.status === "no_keys");
  const overallStatus = hasUnhealthy || modelConfig.status !== "healthy"
    ? "unhealthy"
    : allNoKeys ? "degraded" : "healthy";

  const response = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime_seconds: uptimeSeconds,
    components: { providers, model_config: modelConfig },
  };

  if (overallStatus !== "healthy") {
    return c.json(response, 503);
  }
  return c.json(response);
});

export default app;
