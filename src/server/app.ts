import { Hono } from "hono";

import { createLogger } from "../observability/logger.ts";
import { corsMiddleware } from "./middleware/cors.ts";
import { requestContextMiddleware } from "./middleware/request-context.ts";
import { createAdminRoutes } from "./routes/admin.ts";
import { createAnthropicRoutes } from "./routes/anthropic.ts";
import { createHealthRoutes } from "./routes/health.ts";
import { createOpenAIRoutes } from "./routes/openai.ts";
import { createStaticUIRoutes } from "./routes/static-ui.ts";

const log = createLogger("server");

export function createApp(): Hono {
  const app = new Hono();

  app.use("*", requestContextMiddleware());
  app.use("*", corsMiddleware());

  app.route("/", createHealthRoutes());
  app.route("/", createOpenAIRoutes());
  app.route("/", createAnthropicRoutes());
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
