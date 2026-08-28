#!/usr/bin/env bun
/**
 * Model-Proxy launcher — the entire CLI.
 *
 * `model-proxy` starts the server and opens the admin UI in a browser.
 * Everything else (providers, API keys, models, users) is configured from
 * the UI. Config bootstrap runs BEFORE the server module is imported so
 * stored settings hydrate process.env ahead of any env-derived constants.
 */
import { spawn } from "node:child_process";

import { bootstrapConfig } from "@model-proxy/server/src/config/bootstrap.ts";
import { setDataDir } from "@model-proxy/server/src/config/data-dir.ts";

const VERSION = "2.0.0";

interface CliArgs {
  help: boolean;
  version: boolean;
  open: boolean;
  host: string | undefined;
  port: number;
  dataDir: string | undefined;
  rest: string[];
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    help: false,
    version: false,
    open: true,
    host: undefined,
    port: 9876,
    dataDir: undefined,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--no-open":
        args.open = false;
        break;
      case "--host":
        args.host = argv[++i];
        break;
      case "--port": {
        const parsed = Number.parseInt(argv[++i] ?? "", 10);
        if (Number.isFinite(parsed)) args.port = parsed;
        break;
      }
      case "--data-dir":
        args.dataDir = argv[++i];
        break;
      case "start":
        break;
      default:
        if (arg !== undefined) args.rest.push(arg);
        break;
    }
  }
  return args;
}

function printHelp(): void {
  console.log(`
  Model-Proxy v${VERSION}

  Usage:
    model-proxy [start]           Start the proxy and open the admin UI
    model-proxy --version         Print the version
    model-proxy --help            Show this help

  Options:
    --host <addr>                Listen address (default: 127.0.0.1)
    --port <num>                 Listen port (default: 9876)
    --data-dir <path>            Data directory (default: ~/.model-proxy)
    --no-open                    Do not open the browser

  Everything else is configured from the admin UI. On first boot an admin
  API key is generated and printed here — log in with it.
  `);
}

/** Best-effort platform browser open; failures are silent by design. */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: "ignore",
      detached: true,
    });
    child.unref();
  } catch {
    // Headless environments simply skip the browser.
  }
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
} else if (args.version) {
  console.log(VERSION);
} else {
  if (args.dataDir !== undefined) setDataDir(args.dataDir);
  bootstrapConfig();

  const serveArgs: string[] = ["--port", String(args.port)];
  if (args.host !== undefined) serveArgs.push("--host", args.host);

  const { serve } = await import("@model-proxy/server/src/cli/serve.ts");
  serve(serveArgs);

  const host = args.host ?? process.env.HOST ?? "127.0.0.1";
  const displayHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const url = `http://${displayHost}:${args.port}/`;
  console.log(`\n  Admin UI: ${url}\n`);
  if (args.open) openBrowser(url);
}
