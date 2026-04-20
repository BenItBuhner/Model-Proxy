import { createApp } from "../server/app.ts";
import { createLogger, setLogLevel, type LogLevel } from "../observability/logger.ts";

const log = createLogger("cli");

interface ParsedArgs {
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
        // ignore; kept for CLI parity with the Python `model-proxy start`.
        break;
      default:
        if (arg !== undefined && arg.startsWith("--")) {
          log.warn("ignoring unknown arg", { arg });
        }
        break;
    }
  }

  return { host, port, logLevel };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.logLevel !== undefined) setLogLevel(args.logLevel);

  const app = createApp();

  const server = Bun.serve({
    fetch: app.fetch,
    hostname: args.host,
    port: args.port,
    development: process.env.NODE_ENV !== "production",
  });

  log.info("Model-Proxy listening", {
    url: `http://${server.hostname}:${server.port}`,
    pid: process.pid,
    bun: Bun.version,
  });

  const shutdown = (signal: string) => {
    log.info("shutting down", { signal });
    server.stop(false);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
