import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  deleteModelConfig,
  getRawModelConfig,
  listModelConfigs,
  patchModelConfig,
  writeModelConfig,
} from "../../config/model-writer.ts";
import {
  deleteProviderConfig,
  getRawProviderConfig,
  listProviderConfigs,
  patchProviderConfig,
  writeProviderConfig,
} from "../../config/provider-writer.ts";
import { readEnvFile, writeEnvFile } from "../../config/env-writer.ts";
import { exportBundle } from "../../config/bundle-exporter.ts";
import {
  applyBundle,
  parseBundle,
  previewBundle,
} from "../../config/bundle-importer.ts";
import type { ImportOptions } from "../../../shared/schemas/config-bundle.ts";
import { eventSink } from "../../observability/event-sink.ts";
import { createLogger } from "../../observability/logger.ts";
import { requestLogRingBuffer } from "../../observability/ring-buffer.ts";
import {
  clientApiKeyFingerprint,
  isAuthConfigured,
  requireAuth,
  verifyApiKeyString,
  verifyClientApiKey,
} from "../auth.ts";

const log = createLogger("routes.admin");

const SESSION_COOKIE = "mp_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function currentSessionToken(): string {
  // Session token is a fingerprint of the configured key. If the key changes
  // on disk, all existing sessions immediately become invalid. Simple + safe.
  return clientApiKeyFingerprint() ?? "no-auth";
}

function isSessionValid(c: Parameters<typeof getCookie>[0]): boolean {
  if (!isAuthConfigured()) return true;
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie === undefined) return false;
  return cookie === currentSessionToken();
}

export function createAdminRoutes(): Hono {
  const app = new Hono();

  // -- Auth routes (public — they ESTABLISH the session) ---------------------

  app.get("/v1/admin/auth/status", (c) => {
    if (!isAuthConfigured()) {
      return c.json({
        authenticated: true,
        reason: "no-auth-configured",
      });
    }
    if (verifyClientApiKey(c) || isSessionValid(c)) {
      return c.json({ authenticated: true });
    }
    return c.json({ authenticated: false }, 401);
  });

  app.post("/v1/admin/auth/login", async (c) => {
    if (!isAuthConfigured()) {
      setSession(c);
      return c.json({ authenticated: true, reason: "no-auth-configured" });
    }

    let presentedKey: string | undefined = undefined;
    try {
      const body = (await c.req.json()) as { api_key?: unknown };
      if (typeof body.api_key === "string" && body.api_key.length > 0) {
        presentedKey = body.api_key;
      }
    } catch {
      // no body, fall through to headers
    }

    if (presentedKey === undefined) {
      if (verifyClientApiKey(c)) {
        setSession(c);
        return c.json({ authenticated: true });
      }
      return c.json({ authenticated: false }, 401);
    }

    if (verifyApiKeyString(presentedKey)) {
      setSession(c);
      return c.json({ authenticated: true });
    }
    return c.json({ authenticated: false }, 401);
  });

  app.post("/v1/admin/auth/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ success: true });
  });

  // -- Protected routes go into their own sub-Hono with gate middleware -----
  // The middleware is scoped to admin paths only so that mounting this router
  // at "/" does not accidentally gate the static UI or inference endpoints.
  const protectedApp = new Hono();
  const gate: Parameters<Hono["use"]>[1] = async (c, next) => {
    if (isSessionValid(c)) {
      await next();
      return;
    }
    return requireAuth()(c, next);
  };
  protectedApp.use("/v1/admin/logs", gate);
  protectedApp.use("/v1/admin/config/*", gate);
  protectedApp.use("/v1/admin/events/*", gate);

  protectedApp.get("/v1/admin/logs", (c) => {
    const limitParam = c.req.query("limit");
    const limit = limitParam !== undefined ? Number.parseInt(limitParam, 10) : undefined;
    const records = requestLogRingBuffer.recent(
      Number.isFinite(limit) && limit !== undefined && limit > 0 ? limit : 100,
    );
    return c.json({
      count: records.length,
      total_in_buffer: requestLogRingBuffer.size,
      records,
    });
  });

  // -- Per-request event traces ---------------------------------------------

  protectedApp.get("/v1/admin/events/:requestId", (c) => {
    const id = c.req.param("requestId");
    const trace = eventSink.get(id);
    if (trace === undefined) {
      return c.json({ error: "Unknown requestId" }, 404);
    }
    return c.json({
      requestId: trace.requestId,
      finished: trace.finished,
      startedAt: new Date(trace.startedAt).toISOString(),
      events: trace.events,
    });
  });

  protectedApp.get("/v1/admin/events/:requestId/stream", (c) => {
    const id = c.req.param("requestId");
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const safeEnqueue = (frame: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        // 1. Send any backlog immediately so clients joining mid-flight see history.
        const existing = eventSink.get(id);
        const backlog = existing?.events ?? [];
        const alreadyFinished = existing?.finished ?? false;
        for (const event of backlog) {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
        }

        if (alreadyFinished) {
          close();
          return;
        }

        // 2. Subscribe for live events. `subscribe` creates a placeholder
        //    trace if unknown, so SSE can open BEFORE the POST arrives.
        const unsubscribe = eventSink.subscribe(id, (event) => {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === "request.finished") {
            unsubscribe();
            close();
          }
        });

        // 3. Keep-alive heartbeat so proxies don't kill idle connections.
        const heartbeat = setInterval(() => {
          safeEnqueue(`: keepalive ${Date.now()}\n\n`);
        }, 15000);

        // 4. Client disconnect — clean up promptly.
        const onAbort = () => {
          clearInterval(heartbeat);
          unsubscribe();
          close();
        };
        const signal = c.req.raw.signal;
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // -- Model config CRUD ------------------------------------------------------

  protectedApp.get("/v1/admin/config/models", (c) => {
    return c.json({ models: listModelConfigs() });
  });

  protectedApp.get("/v1/admin/config/models/:name", (c) => {
    const name = c.req.param("name");
    try {
      return c.json({ model: getRawModelConfig(name) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  protectedApp.post("/v1/admin/config/models/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeModelConfig(name, body, { overwrite: false });
      return c.json({ model: config }, 201);
    } catch (err) {
      log.warn("create model failed", { name, err: String(err) });
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.put("/v1/admin/config/models/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeModelConfig(name, body, { overwrite: true });
      return c.json({ model: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.patch("/v1/admin/config/models/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = patchModelConfig(name, body as Record<string, unknown>);
      return c.json({ model: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.delete("/v1/admin/config/models/:name", (c) => {
    const name = c.req.param("name");
    const ok = deleteModelConfig(name);
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true, name });
  });

  // -- Provider config CRUD ---------------------------------------------------

  protectedApp.get("/v1/admin/config/providers", (c) => {
    return c.json({ providers: listProviderConfigs() });
  });

  protectedApp.get("/v1/admin/config/providers/:name", (c) => {
    const name = c.req.param("name");
    try {
      return c.json({ provider: getRawProviderConfig(name) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  protectedApp.post("/v1/admin/config/providers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeProviderConfig(name, body, { overwrite: false });
      return c.json({ provider: config }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.put("/v1/admin/config/providers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeProviderConfig(name, body, { overwrite: true });
      return c.json({ provider: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.patch("/v1/admin/config/providers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = patchProviderConfig(name, body as Record<string, unknown>);
      return c.json({ provider: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.delete("/v1/admin/config/providers/:name", (c) => {
    const name = c.req.param("name");
    const ok = deleteProviderConfig(name);
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true, name });
  });

  // -- Env file ---------------------------------------------------------------

  protectedApp.get("/v1/admin/config/env", (c) => {
    const revealParam = c.req.query("reveal");
    const reveal = revealParam === "true" || revealParam === "1";
    const parsed = readEnvFile({ includeValues: reveal });
    return c.json({
      path: parsed.path,
      reveal,
      entries: parsed.entries,
    });
  });

  protectedApp.put("/v1/admin/config/env", async (c) => {
    const body = (await c.req.json()) as {
      entries?: Array<{ key: string; value: string }>;
    };
    if (!Array.isArray(body.entries)) {
      return c.json({ error: "Request body must contain an 'entries' array" }, 400);
    }
    const result = writeEnvFile({ entries: body.entries });
    return c.json({
      path: result.path,
      applied: result.applied,
      skipped: result.skipped,
    });
  });

  // -- Full configuration bundle (import / export) --------------------------

  protectedApp.get("/v1/admin/config/export", () => {
    const bundle = exportBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `model-proxy-config-${stamp}.json`;
    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  });

  protectedApp.post("/v1/admin/config/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json(
        { error: `Request body must be valid JSON: ${(err as Error).message}` },
        400,
      );
    }

    const envelope = (body ?? {}) as {
      bundle?: unknown;
      options?: ImportOptions;
    };
    const bundleRaw = envelope.bundle ?? body; // accept either { bundle, options } or a bare bundle.
    const opts = envelope.options;

    let bundle;
    try {
      bundle = parseBundle(bundleRaw);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const dryRunParam = c.req.query("dry_run");
    const dryRun = dryRunParam === "true" || dryRunParam === "1";

    try {
      if (dryRun) {
        const diff = previewBundle(bundle, opts);
        return c.json({ dry_run: true, ...diff });
      }
      const report = applyBundle(bundle, opts);
      return c.json({ dry_run: false, ...report });
    } catch (err) {
      log.error("bundle import failed", {
        err: (err as Error).message,
      });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.route("/", protectedApp);
  return app;
}

function setSession(c: Parameters<typeof setCookie>[0]): void {
  setCookie(c, SESSION_COOKIE, currentSessionToken(), {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE,
  });
}
