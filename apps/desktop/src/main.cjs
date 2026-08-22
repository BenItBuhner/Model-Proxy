/**
 * Model-Proxy desktop shell.
 *
 * Thin Electron wrapper around the exact same engine + admin UI:
 *   1. Ensure a per-install admin key (stored in Electron userData).
 *   2. Spawn the compiled Model-Proxy server binary as a sidecar bound to
 *      127.0.0.1 on a free port, with its data dir under userData.
 *   3. Wait for /health, open a BrowserWindow at the server origin.
 *   4. The preload script auto-logs-in with the admin key, so the desktop
 *      app never shows a login screen.
 *
 * Zero forked frontend code: the window renders the same static Next.js
 * export the self-hosted server serves.
 */
const { app, BrowserWindow, Menu, Tray, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const net = require("node:net");
const path = require("node:path");

/** @type {import('node:child_process').ChildProcess | undefined} */
let sidecar;
/** @type {BrowserWindow | undefined} */
let mainWindow;
/** @type {Tray | undefined} */
let tray;
let quitting = false;

function userDataPath(...parts) {
  return path.join(app.getPath("userData"), ...parts);
}

/** Per-install admin key, created once and reused across launches. */
function ensureAdminKey() {
  const keyPath = userDataPath("admin-key.json");
  if (existsSync(keyPath)) {
    try {
      const parsed = JSON.parse(readFileSync(keyPath, "utf8"));
      if (typeof parsed.key === "string" && parsed.key.length > 0) return parsed.key;
    } catch {
      // regenerate below
    }
  }
  const key = `mp_${randomBytes(24).toString("base64url")}`;
  mkdirSync(path.dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, JSON.stringify({ key }, null, 2), { mode: 0o600 });
  return key;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address !== null
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
    server.on("error", reject);
  });
}

/**
 * Locate the server sidecar. Packaged builds ship the compiled binary in
 * resources/; dev falls back to the repo's dist build or plain `bun run`.
 */
function resolveSidecarCommand() {
  const override = process.env.MODEL_PROXY_SIDECAR;
  if (override !== undefined && override.length > 0) {
    return { command: override, args: [] };
  }
  const binaryName = process.platform === "win32" ? "model-proxy.exe" : "model-proxy";
  if (app.isPackaged) {
    return { command: path.join(process.resourcesPath, binaryName), args: [] };
  }
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const devBinary = path.join(repoRoot, "dist", binaryName);
  if (existsSync(devBinary)) return { command: devBinary, args: [] };
  return {
    command: "bun",
    args: ["run", path.join(repoRoot, "packages", "server", "src", "cli", "main.ts")],
  };
}

function resolveWebRoot() {
  if (app.isPackaged) return path.join(process.resourcesPath, "web-static");
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  return path.join(repoRoot, "apps", "web", "out");
}

async function startSidecar(adminKey, port) {
  const { command, args } = resolveSidecarCommand();
  const dataDir = userDataPath("model-proxy");
  mkdirSync(dataDir, { recursive: true });

  sidecar = spawn(command, [...args, "--host", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env,
      MODEL_PROXY_DATA_DIR: dataDir,
      MODEL_PROXY_WEB_ROOT: resolveWebRoot(),
      CLIENT_API_KEY: adminKey,
      HOST: "127.0.0.1",
      PORT: String(port),
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  sidecar.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  sidecar.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  sidecar.on("exit", (code) => {
    if (!quitting) {
      console.error(`Model-Proxy sidecar exited unexpectedly (code ${code})`);
      app.quit();
    }
  });
}

async function waitForHealth(baseUrl, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Model-Proxy server did not become healthy in time");
}

function createWindow(baseUrl, adminKey) {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    title: "Model Proxy",
    backgroundColor: "#101010",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [`--mp-admin-key=${adminKey}`],
    },
  });

  // External links open in the OS browser, never inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(baseUrl)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  mainWindow.on("close", (event) => {
    // Closing the window keeps the proxy running in the tray.
    if (!quitting && tray !== undefined) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  // Automated smoke-test hook: capture the rendered window and exit.
  const screenshotPath = process.env.MP_DESKTOP_SCREENSHOT;
  if (screenshotPath !== undefined && screenshotPath.length > 0) {
    mainWindow.webContents.on("did-finish-load", () => {
      setTimeout(async () => {
        try {
          const image = await mainWindow.webContents.capturePage();
          writeFileSync(screenshotPath, image.toPNG());
          console.log(`screenshot written: ${screenshotPath}`);
        } catch (err) {
          console.error("screenshot failed:", err);
        }
        app.quit();
      }, 4_000);
    });
  }

  void mainWindow.loadURL(`${baseUrl}/`);
}

function createTray(baseUrl) {
  const icon = path.join(__dirname, "..", "assets", "trayTemplate.png");
  if (!existsSync(icon)) return;
  try {
    tray = new Tray(icon);
  } catch {
    return; // tray is best-effort (some Linux desktops have none)
  }
  const menu = Menu.buildFromTemplate([
    {
      label: "Open Model Proxy",
      click: () => {
        if (mainWindow === undefined || mainWindow.isDestroyed()) {
          const key = ensureAdminKey();
          createWindow(baseUrl, key);
        } else {
          mainWindow.show();
        }
      },
    },
    { label: "Open in browser", click: () => void shell.openExternal(`${baseUrl}/`) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
  tray.setToolTip("Model Proxy");
  tray.setContextMenu(menu);
}

app.on("before-quit", () => {
  quitting = true;
  if (sidecar !== undefined && sidecar.exitCode === null) {
    sidecar.kill("SIGTERM");
  }
});

app.on("window-all-closed", () => {
  // Keep running in the tray; quit only from the tray or Cmd+Q.
  if (tray === undefined && process.platform !== "darwin") app.quit();
});

app.whenReady().then(async () => {
  try {
    const adminKey = ensureAdminKey();
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    await startSidecar(adminKey, port);
    await waitForHealth(baseUrl);
    createTray(baseUrl);
    createWindow(baseUrl, adminKey);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(baseUrl, adminKey);
      else mainWindow?.show();
    });
  } catch (err) {
    console.error("Failed to start Model-Proxy desktop:", err);
    app.quit();
  }
});
