import { createApp } from "../server/app.ts";
import { createLogger, setLogLevel, type LogLevel } from "../observability/logger.ts";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const log = createLogger("cli");

interface ParsedArgs {
  command: "start" | "login" | undefined;
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
  let command: "start" | "login" | undefined;

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
      case "login":
        command = "login";
        break;
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

const CODEBUFF_API_BASE = "https://www.codebuff.com/api/v1";
const CODEBUFF_AUTH_BASE = "https://www.codebuff.com/api/auth";

async function login(): Promise<void> {
  console.log("");
  console.log("  Codebuff / Freebuff Login");
  console.log("  ─────────────────────────");
  console.log("");

  const fingerprintId = `model-proxy-${crypto.randomUUID()}`;

  // Step 1: Get auth code
  console.log("  Requesting login URL...");
  const codeResp = await fetch(`${CODEBUFF_AUTH_BASE}/cli/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fingerprintId }),
  });
  if (!codeResp.ok) {
    console.error(`  Error: HTTP ${codeResp.status} — could not request login code`);
    process.exit(1);
  }
  const { fingerprintHash, loginUrl, expiresAt } = await codeResp.json();
  if (!loginUrl) {
    console.error("  Error: no login URL returned");
    process.exit(1);
  }

  console.log("");
  console.log(`  Open this URL in your browser to log in:`);
  console.log("");
  console.log(`    ${loginUrl}`);
  console.log("");
  console.log("  Authenticate with GitHub or Google, then return here.");
  console.log("  The CLI will auto-detect when you've logged in.");
  console.log("");

  // Step 2: Poll for token
  const pollUntil = Math.min(
    expiresAt ?? Date.now() + 300_000,
    Date.now() + 300_000,
  );
  const pollIntervalMs = 2000;
  let pollCount = 0;

  while (Date.now() < pollUntil) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    pollCount++;

    try {
      const statusResp = await fetch(
        `${CODEBUFF_AUTH_BASE}/cli/status?fingerprintId=${encodeURIComponent(fingerprintId)}&fingerprintHash=${encodeURIComponent(fingerprintHash ?? "")}&expiresAt=${encodeURIComponent(String(expiresAt ?? ""))}`,
      );
      if (statusResp.status === 200) {
        const body = await statusResp.text();
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(body);
        } catch {
          continue;
        }
        const token: string | undefined =
          (data.authToken as string) ?? (data.token as string);
        if (token) {
          console.log("  ✅ Authenticated!");
          await saveToken(token, fingerprintId);
          console.log("");
          console.log(`  CODECUFF_API_KEY set in .env`);
          console.log(`  Credentials saved to ~/.config/manicode/credentials.json`);
          console.log("");
          console.log("  The codebuff provider is ready to use.");
          return;
        }
      }
      if (pollCount % 5 === 0) {
        console.log(`  Still waiting... (${pollCount * 2}s elapsed)`);
      }
    } catch {
      // network hiccup, retry
    }
  }

  console.error("  Timed out waiting for login. Run again and try completing the browser flow.");
  process.exit(1);
}

async function saveToken(token: string, fingerprintId: string): Promise<void> {
  // Save credentials file
  const credsDir = path.join(process.env.HOME || process.cwd(), ".config", "manicode");
  const credsPath = path.join(credsDir, "credentials.json");
  const creds = {
    default: {
      id: fingerprintId,
      name: "model-proxy-user",
      email: "",
      authToken: token,
      fingerprintId,
    },
  };
  fs.mkdirSync(credsDir, { recursive: true });
  fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), "utf-8");

  // Write/update .env
  const envPath = path.join(process.cwd(), ".env");
  let envContent = "";
  const existingEntry = `CODECUFF_API_KEY=${token}`;
  try {
    envContent = fs.readFileSync(envPath, "utf-8");
    if (envContent.includes("CODECUFF_API_KEY=")) {
      envContent = envContent.replace(/^CODECUFF_API_KEY=.*$/m, existingEntry);
    } else {
      envContent += `\n${existingEntry}\n`;
    }
  } catch {
    envContent = `${existingEntry}\n`;
  }
  fs.writeFileSync(envPath, envContent, "utf-8");
}

function printHelp(): void {
  console.log(`
  Model-Proxy v2
  
  Usage:
    model-proxy [start]          Start the proxy server
    model-proxy login            Authenticate with Codebuff/Freebuff
    model-proxy --help           Show this help
  
  Options:
    --host <addr>               Listen address (default: 127.0.0.1)
    --port <num>                Listen port (default: 9876)
    --log-level <level>         debug | info | warn | error
  
  Login command:
    Walks through the freebuff/Codebuff OAuth flow, saves the API key
    to ~/.config/manicode/credentials.json and writes CODECUFF_API_KEY
    to .env so the codebuff provider can use it.
  `);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);
  if (args.logLevel !== undefined) setLogLevel(args.logLevel);

  if (args.command === "login") {
    login().catch((e) => {
      console.error("Login failed:", e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
    return;
  }

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
