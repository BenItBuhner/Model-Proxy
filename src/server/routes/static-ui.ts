import { existsSync, statSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";

import { createLogger } from "../../observability/logger.ts";

const log = createLogger("routes.setup-static");

/**
 * Locate the static UI directory produced by `web/` `next build` with
 * `output: 'export'`. Tried in priority order:
 *   1. $MODEL_PROXY_WEB_ROOT
 *   2. ./web-static           (Docker image layout)
 *   3. ../web-static          (alt Docker layout)
 *   4. ./web/out              (running from repo root during dev)
 *   5. Relative to this module (handy for `bun run dev`)
 */
function resolveWebRoot(): string | undefined {
  const explicit = process.env.MODEL_PROXY_WEB_ROOT;
  const candidates: string[] = [];
  if (explicit !== undefined && explicit.length > 0) candidates.push(explicit);

  candidates.push(join(process.cwd(), "web-static"));
  candidates.push(resolve(process.cwd(), "..", "web-static"));
  candidates.push(join(process.cwd(), "web", "out"));

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const repoRoot = resolve(here, "..", "..", "..");
    candidates.push(join(repoRoot, "web", "out"));
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
 * Safely resolve an incoming /setup/* request path to an on-disk file
 * inside `webRoot`. Refuses any path that escapes webRoot via `..`.
 */
function resolveAssetPath(requestPath: string, webRoot: string): string | undefined {
  let trimmed = requestPath.replace(/^\/setup\/?/, "");
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

  if (webRoot === undefined) {
    log.warn(
      "static UI not found; /setup/* will 404 (set MODEL_PROXY_WEB_ROOT or run `bun run -C web build`)",
    );
    app.get("/setup", (c) => c.redirect("/setup/", 302));
    app.get("/setup/*", (c) =>
      c.json(
        {
          error: {
            message:
              "Static UI not bundled. Build `web/` and either copy `web/out/` to `web-static/` or set MODEL_PROXY_WEB_ROOT.",
            type: "not_found",
          },
        },
        404,
      ),
    );
    return app;
  }

  log.info("serving static UI", { webRoot });

  // Canonicalise `/setup` → `/setup/` so relative asset paths resolve.
  app.get("/setup", (c) => c.redirect("/setup/", 302));

  app.get("/setup/*", (c) => {
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

    // HTML route fallback (e.g. `/setup/models` without trailing slash).
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
