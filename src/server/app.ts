import { Hono } from "hono";

import { createLogger } from "../observability/logger.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { requestContextMiddleware } from "./middleware/request-context.ts";
import { createAdminRoutes } from "./routes/admin.ts";
import { createAccountRoutes } from "./routes/accounts.ts";
import { createAnthropicRoutes } from "./routes/anthropic.ts";
import { createAudioRoutes } from "./routes/audio.ts";
import { createHealthRoutes } from "./routes/health.ts";
import { createOpenAIRoutes } from "./routes/openai.ts";
import { createStaticUIRoutes } from "./routes/static-ui.ts";
import { isDraining } from "./lifecycle.ts";
import { startConvexMirror } from "../storage/convex-mirror.ts";

const log = createLogger("server");

export function createApp(): Hono {
  startConvexMirror();
  const app = new Hono();

  app.use("*", requestContextMiddleware());
  app.use("*", corsMiddleware());
  app.use("*", async (c, next) => {
    if (!isDraining() || c.req.path.startsWith("/health")) {
      return next();
    }
    return c.json(
      {
        error: {
          message: "Model-Proxy is draining for deploy; retry against the frontdoor.",
          type: "service_unavailable",
        },
      },
      503,
      {
        "Retry-After": "5",
      },
    );
  });

  app.route("/", createHealthRoutes());
  app.route("/", createOpenAIRoutes());
  app.route("/", createAnthropicRoutes());
  app.route("/", createAudioRoutes());
  app.route("/", createAccountRoutes());
  app.route("/", createAdminRoutes());
  app.route("/", createStaticUIRoutes());

  app.get("/", (c) =>
    c.json({
      service: "model-proxy",
      version: "2.0.0-dev",
      docs: "/setup/",
    }),
  );

  app.notFound((c) =>
    c.json(
      {
        error: {
          message: `Not found: ${c.req.method} ${c.req.path}`,
          type: "not_found",
        },
      },
      404,
    ),
  );

  app.onError((err, c) => {
    const requestId = c.get("requestId");
    log.error("unhandled error", {
      requestId,
      err,
      path: c.req.path,
      method: c.req.method,
    });
    return c.json(
      {
        error: {
          message: err.message || "Internal server error",
          type: "internal_server_error",
          request_id: requestId,
        },
      },
      500,
    );
  });

  return app;
}
