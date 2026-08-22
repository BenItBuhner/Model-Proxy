import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import { createLogger } from "../../observability/logger.ts";

const log = createLogger("routes.static-ui");

/** Path prefixes owned by the API — never served from the static UI. */
const API_PREFIXES = ["/v1/", "/health"];

function isApiPath(path: string): boolean {
  if (path === "/v1") return true;
  return API_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Locate the static UI directory produced by `apps/web` `next build` with
 * `output: 'export'`. Tried in priority order:
 *   1. $MODEL_PROXY_WEB_ROOT
 *   2. ./web-static           (Docker image layout)
 *   3. ../web-static          (alt Docker layout)
 *   4. ./apps/web/out         (running from repo root during dev)
 *   5. Relative to this module (handy for `bun run dev`)
 */
function resolveWebRoot(): string | undefined {
  const explicit = process.env.MODEL_PROXY_WEB_ROOT;
  const candidates: string[] = [];
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit);

  candidates.push(join(process.cwd(), "web-static"));
  candidates.push(resolve(process.cwd(), "..", "web-static"));
  candidates.push(join(process.cwd(), "apps", "web", "out"));

  try {
    // packages/server/src/server/routes/static-ui.ts -> repo root is five up
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..", "..", "..", "..");
    candidates.push(join(repoRoot, "apps", "web", "out"));
    candidates.push(join(repoRoot, "web-static"));
  } catch {
    // ignore
  }

  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, "index.html"))) return candidate;
    } catch {
      // skip
    }
  }
  return undefined;
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};

function mimeFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * Safely resolve an incoming request path to an on-disk file inside
 * `webRoot`. Refuses any path that escapes webRoot via `..`.
 */
function resolveAssetPath(requestPath: string, webRoot: string): string | undefined {
  let trimmed = requestPath.replace(/^\/+/, "");
  // Strip querystring if it slipped in (hono gives us just the path, but defensive).
  const qIdx = trimmed.indexOf("?");
  if (qIdx !== -1) trimmed = trimmed.slice(0, qIdx);
  if (trimmed.length === 0) trimmed = "index.html";

  const decoded = (() => {
    try {
      return decodeURIComponent(trimmed);
    } catch {
      return trimmed;
    }
  })();

  // Normalise + guard against path traversal.
  const resolved = resolve(webRoot, decoded);
  const rootNorm = resolve(webRoot);
  if (!resolved.startsWith(rootNorm + sep) && resolved !== rootNorm) {
    return undefined;
  }
  return resolved;
}

function loadFileOrDirIndex(path: string): string | undefined {
  try {
    const stat = statSync(path);
    if (stat.isFile()) return path;
    if (stat.isDirectory()) {
      const idx = join(path, "index.html");
      if (existsSync(idx)) return idx;
    }
  } catch {
    // fall through
  }
  return undefined;
}

export function createStaticUIRoutes(): Hono {
  const app = new Hono();
  const webRoot = resolveWebRoot();

  // Legacy bookmarks: the admin UI used to live under /setup/.
  app.get("/setup", (c) => c.redirect("/", 302));
  app.get("/setup/*", (c) =>
    c.redirect(c.req.path.replace(/^\/setup\/?/, "/"), 302),
  );

  if (webRoot === undefined) {
    log.warn(
      "static UI not found; the admin UI will 404 (set MODEL_PROXY_WEB_ROOT or run `bun run build:web`)",
    );
    app.get("/*", (c) => {
      if (isApiPath(c.req.path)) return c.notFound();
      return c.json(
        {
          error: {
            message:
              "Static UI not bundled. Build `apps/web/` and either copy `apps/web/out/` to `web-static/` or set MODEL_PROXY_WEB_ROOT.",
            type: "not_found",
          },
        },
        404,
      );
    });
    return app;
  }

  log.info("serving static UI at /", { webRoot });

  app.get("/*", (c) => {
    // API paths fall through to the JSON 404 handler; the UI never shadows them.
    if (isApiPath(c.req.path)) return c.notFound();

    const assetPath = resolveAssetPath(c.req.path, webRoot);
    if (assetPath === undefined) {
      return c.json(
        { error: { message: "Forbidden path", type: "not_found" } },
        403,
      );
    }

    const resolvedFile = loadFileOrDirIndex(assetPath);
    if (resolvedFile !== undefined) {
      const mime = mimeFor(resolvedFile);
      const bunFile = Bun.file(resolvedFile);
      const immutableSegment = `${sep}_next${sep}static${sep}`;
      return new Response(bunFile, {
        headers: {
          "Content-Type": mime,
          "Cache-Control": resolvedFile.includes(immutableSegment)
            ? "public, max-age=31536000, immutable"
            : "public, max-age=60",
        },
      });
    }

    // HTML route fallback (e.g. `/models` without trailing slash).
    if (!/\.[a-z0-9]+$/i.test(assetPath)) {
      const fallbackHtml = loadFileOrDirIndex(`${assetPath}.html`);
      if (fallbackHtml !== undefined) {
        return new Response(Bun.file(fallbackHtml), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // Asset genuinely missing — return a real 404 so the browser reports
    // it (previously this leaked index.html with the wrong MIME type).
    return c.notFound();
  });

  return app;
}
