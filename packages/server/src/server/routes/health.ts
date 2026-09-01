import { Hono } from "hono";

import { modelConfigLoader } from "../../config/model-loader.ts";
import { providerConfigLoader } from "../../config/provider-loader.ts";
import { getOperationalDb } from "../../storage/operational-db.ts";
import { getStorageRoot } from "../../storage/storage-paths.ts";
import { isAuthConfigured } from "../auth.ts";
import { deploymentState, isDraining, uptimeSeconds } from "../lifecycle.ts";
import { activeRequestCount } from "../request-log.ts";

interface ReadinessCheck {
  name: string;
  ok: boolean;
  message?: string;
}

function readiness() {
  const checks: ReadinessCheck[] = [];
  let models: string[] = [];
  let providers: string[] = [];

  try {
    models = modelConfigLoader.getAvailableModels();
    checks.push({
      name: "models",
      ok: models.length > 0,
      message: models.length > 0 ? `${models.length} model(s) available` : "no model configs found",
    });
  } catch (err) {
    checks.push({
      name: "models",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    providers = providerConfigLoader.getAvailableProviders();
    checks.push({
      name: "providers",
      ok: providers.length > 0,
      message:
        providers.length > 0 ? `${providers.length} provider(s) available` : "no provider configs found",
    });
  } catch (err) {
    checks.push({
      name: "providers",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    getOperationalDb().query("SELECT 1 AS ok").get();
    checks.push({
      name: "operational_db",
      ok: true,
      message: "sqlite operational store opened",
    });
  } catch (err) {
    checks.push({
      name: "operational_db",
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const draining = isDraining();
  checks.push({
    name: "drain_state",
    ok: !draining,
    message: draining ? "instance is draining" : "accepting new requests",
  });

  const ready = checks.every((check) => check.ok);
  return {
    status: ready ? "ready" : "not_ready",
    ready,
    uptime_seconds: uptimeSeconds(),
    active_requests: activeRequestCount(),
    deployment: deploymentState(),
    storage: {
      root: getStorageRoot(),
    },
    models_count: models.length,
    providers_count: providers.length,
    checks,
  };
}

export function createHealthRoutes(): Hono {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      uptime_seconds: uptimeSeconds(),
      draining: isDraining(),
      active_requests: activeRequestCount(),
    }),
  );

  app.get("/health/ready", (c) => {
    const draining = isDraining();
    let dbOk = true;
    let dbMessage = "sqlite operational store opened";
    try {
      getOperationalDb().query("SELECT 1 AS ok").get();
    } catch (err) {
      dbOk = false;
      dbMessage = err instanceof Error ? err.message : String(err);
    }
    const ready = dbOk && !draining;
    return c.json(
      {
        status: ready ? "ready" : "not_ready",
        ready,
        uptime_seconds: uptimeSeconds(),
        active_requests: activeRequestCount(),
        deployment: deploymentState(),
        storage: {
          root: getStorageRoot(),
        },
        checks: [
          {
            name: "operational_db",
            ok: dbOk,
            message: dbMessage,
          },
          {
            name: "drain_state",
            ok: !draining,
            message: draining ? "instance is draining" : "accepting new requests",
          },
        ],
      },
      ready ? 200 : 503,
    );
  });

  app.get("/health/detailed", (c) => {
    const models = modelConfigLoader.getAvailableModels();
    const providers = providerConfigLoader.getAvailableProviders();
    const ready = readiness();
    return c.json({
      status: "ok",
      uptime_seconds: uptimeSeconds(),
      active_requests: activeRequestCount(),
      auth_configured: isAuthConfigured(),
      models_count: models.length,
      providers_count: providers.length,
      models,
      providers,
      readiness: ready,
      deployment: deploymentState(),
      storage: {
        root: getStorageRoot(),
      },
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
