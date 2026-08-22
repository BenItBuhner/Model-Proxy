import { createApp } from "../server/app.ts";
import { markDraining } from "../server/lifecycle.ts";
import { activeRequestCount } from "../server/request-log.ts";
import { createLogger, setLogLevel, type LogLevel } from "../observability/logger.ts";
import {
  isResponsesWsPath,
  onWsClose,
  onWsDrain,
  onWsMessage,
  onWsOpen,
  responsesWsAuth,
  type WsData,
} from "../server/routes/responses-ws.ts";

const log = createLogger("cli");

interface ParsedArgs {
  command: "start" | undefined;
  host: string;
  port: number;
  logLevel: LogLevel | undefined;
}

function parseArgs(argv: string[]): ParsedArgs {
  let host = process.env.HOST ?? process.env.MODEL_PROXY_HOST ?? "127.0.0.1";
  let port = Number.parseInt(
    process.env.PORT ?? process.env.MODEL_PROXY_PORT ?? "9876",
    10,
  );
  let logLevel: LogLevel | undefined;
  let command: "start" | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--host":
        host = argv[++i] ?? host;
        break;
      case "--port": {
        const next = argv[++i];
        if (next !== undefined) {
          const parsed = Number.parseInt(next, 10);
          if (Number.isFinite(parsed)) port = parsed;
        }
        break;
      }
      case "--log-level": {
        const next = argv[++i];
        if (
          next === "debug" ||
          next === "info" ||
          next === "warn" ||
          next === "error"
        ) {
          logLevel = next;
        }
        break;
      }
      case "start":
        command = "start";
        break;
      default:
        if (arg !== undefined && arg.startsWith("--")) {
          log.warn("ignoring unknown arg", { arg });
        }
        break;
    }
  }

  return { command, host, port, logLevel };
}

function printHelp(): void {
  console.log(`
  Model-Proxy v2
  
  Usage:
    model-proxy [start]          Start the proxy server
    model-proxy --help           Show this help
  
  Options:
    --host <addr>               Listen address (default: 127.0.0.1)
    --port <num>                Listen port (default: 9876)
    --log-level <level>         debug | info | warn | error
  `);
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);
  if (args.logLevel !== undefined) setLogLevel(args.logLevel);

  const app = createApp();

  const server = Bun.serve<WsData>({
    async fetch(req, server) {
      const url = new URL(req.url);
      const upgradeHeader = req.headers.get("upgrade")?.toLowerCase();
      if (isResponsesWsPath(url.pathname) && upgradeHeader === "websocket") {
        const principal = await responsesWsAuth(req);
        if (principal === undefined) {
          return new Response("Unauthorized", { status: 401 });
        }
        const upgraded = server.upgrade(req, {
          data: { request: req, principal },
        });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 426 });
        }
        return;
      }
      return app.fetch(req, server);
    },
    websocket: {
      open(ws) { onWsOpen(ws); },
      message(ws, raw) { onWsMessage(ws, raw); },
      close(ws) { onWsClose(ws); },
      drain(ws) { onWsDrain(ws); },
    },
    hostname: args.host,
    port: args.port,
    development: process.env.NODE_ENV !== "production",
    idleTimeout: 240,
  });

  log.info("Model-Proxy listening", {
    url: `http://${server.hostname}:${server.port}`,
    pid: process.pid,
    bun: Bun.version,
    instanceColor: process.env.MODEL_PROXY_INSTANCE_COLOR ?? "single",
    buildId: process.env.MODEL_PROXY_BUILD_ID ?? "local",
  });

  const drainTimeoutMs = parsePositiveInt(process.env.MODEL_PROXY_DRAIN_TIMEOUT_MS, 300_000);
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) {
      log.warn("received second shutdown signal; forcing close", { signal });
      server.stop(true);
      process.exit(1);
    }
    shuttingDown = true;
    markDraining(signal);
    log.info("shutdown signal received; draining in-flight requests", {
      signal,
      drainTimeoutMs,
    });

    void (async () => {
      const deadline = Date.now() + drainTimeoutMs;

      // Phase 1: wait for tracked in-flight requests (including active SSE
      // streams) to finish before tearing the server down. New requests are
      // already rejected with 503 by the draining middleware.
      let lastLogged = -1;
      while (Date.now() < deadline) {
        const active = activeRequestCount();
        if (active === 0) break;
        if (active !== lastLogged) {
          log.info("draining: waiting for in-flight requests to finish", {
            signal,
            active,
            remainingMs: Math.max(0, deadline - Date.now()),
          });
          lastLogged = active;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      const remainingAfterDrain = activeRequestCount();
      if (remainingAfterDrain > 0) {
        log.warn("drain deadline reached with requests still in flight", {
          signal,
          active: remainingAfterDrain,
        });
      } else {
        log.info("all in-flight requests drained cleanly", { signal });
      }

      // Phase 2: close the HTTP server, giving any remaining connections the
      // rest of the drain budget before forcing them closed.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = Symbol("drain-timeout");
      const remainingBudget = Math.max(5_000, deadline - Date.now());
      const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
        timeout = setTimeout(() => resolve(timedOut), remainingBudget);
      });

      try {
        const result = await Promise.race([server.stop(), timeoutPromise]);
        if (timeout !== undefined) clearTimeout(timeout);
        if (result === timedOut) {
          log.warn("drain timeout reached; forcing active connections closed", {
            signal,
            drainTimeoutMs,
          });
          server.stop(true);
          process.exit(1);
        }
        log.info("graceful shutdown complete", { signal });
        process.exit(0);
      } catch (err) {
        if (timeout !== undefined) clearTimeout(timeout);
        log.error("graceful shutdown failed; forcing close", { signal, err });
        server.stop(true);
        process.exit(1);
      }
    })();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
