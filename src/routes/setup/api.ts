/**
 * Setup API routes for the web-based configuration UI.
 */
import { Hono } from "hono";
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { getWritableConfigDir, getConfigSearchPaths } from "../../core/config-paths.ts";
import { getAvailableKeys } from "../../core/api-key-manager.ts";

const app = new Hono();

function getProvidersDir() { return join(getWritableConfigDir(), "providers"); }
function getModelsDir() { return join(getWritableConfigDir(), "models"); }

function loadAllProviders(): Record<string, any> {
  const providers: Record<string, any> = {};
  for (const root of getConfigSearchPaths()) {
    const dir = join(root, "providers");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
        if (data.name && !(data.name in providers)) providers[data.name] = data;
      } catch {}
    }
  }
  return providers;
}

function loadAllModelNames(): string[] {
  const models = new Set<string>();
  for (const root of getConfigSearchPaths()) {
    const dir = join(root, "models");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".json")) models.add(file.replace(".json", ""));
    }
  }
  return [...models].sort();
}

function loadModelConfig(name: string): Record<string, any> | null {
  for (const root of getConfigSearchPaths()) {
    const path = join(root, "models", `${name}.json`);
    if (existsSync(path)) {
      try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
    }
  }
  return null;
}

// Status
app.get("/api/status", (c) => {
  const providers = loadAllProviders();
  const modelNames = loadAllModelNames();
  const enabledCount = Object.values(providers).filter((p: any) => p.enabled !== false).length;
  let withKeys = 0;
  for (const name of Object.keys(providers)) {
    if (getAvailableKeys(name).length > 0) withKeys++;
  }
  return c.json({
    status: "ok",
    stats: {
      total_providers: Object.keys(providers).length,
      enabled_providers: enabledCount,
      providers_with_keys: withKeys,
      total_models: modelNames.length,
    },
    config_dir: getWritableConfigDir(),
  });
});

// Providers CRUD
app.get("/api/providers", (c) => {
  const providers = loadAllProviders();
  return c.json({ providers, count: Object.keys(providers).length });
});

app.get("/api/providers/:name", (c) => {
  const name = c.req.param("name");
  const providers = loadAllProviders();
  if (!(name in providers)) return c.json({ error: `Provider '${name}' not found` }, 404);
  return c.json(providers[name]);
});

app.post("/api/providers", async (c) => {
  const body = await c.req.json();
  const name = body.name;
  if (!name) return c.json({ error: "name is required" }, 400);

  const dir = getProvidersDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.json`);

  if (existsSync(filePath) && !body._overwrite) {
    return c.json({ error: `Provider '${name}' already exists. Set _overwrite to replace.` }, 400);
  }

  const { _overwrite, ...data } = body;
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return c.json({ status: "success", message: `Provider '${name}' saved` });
});

app.delete("/api/providers/:name", (c) => {
  const name = c.req.param("name");
  const filePath = join(getProvidersDir(), `${name}.json`);
  if (!existsSync(filePath)) return c.json({ error: `Provider '${name}' not found` }, 404);
  unlinkSync(filePath);
  return c.json({ status: "success", message: `Provider '${name}' deleted` });
});

// Models CRUD
app.get("/api/models", (c) => {
  const names = loadAllModelNames();
  const models = names.map((name) => {
    const config = loadModelConfig(name);
    return { name, config };
  }).filter((m) => m.config !== null);
  return c.json({ models, count: models.length });
});

app.get("/api/models/:name", (c) => {
  const name = c.req.param("name");
  const config = loadModelConfig(name);
  if (!config) return c.json({ error: `Model '${name}' not found` }, 404);
  return c.json({ name, config });
});

app.post("/api/models", async (c) => {
  const body = await c.req.json();
  const name = body.logical_name;
  if (!name) return c.json({ error: "logical_name is required" }, 400);

  const dir = getModelsDir();
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${name}.json`);

  if (existsSync(filePath) && !body._overwrite) {
    return c.json({ error: `Model '${name}' already exists. Set _overwrite to replace.` }, 400);
  }

  const { _overwrite, ...data } = body;
  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return c.json({ status: "success", message: `Model '${name}' saved` });
});

app.delete("/api/models/:name", (c) => {
  const name = c.req.param("name");
  const filePath = join(getModelsDir(), `${name}.json`);
  if (!existsSync(filePath)) return c.json({ error: `Model '${name}' not found` }, 404);
  unlinkSync(filePath);
  return c.json({ status: "success", message: `Model '${name}' deleted` });
});

// Provider key status
app.get("/api/providers/:name/keys", (c) => {
  const name = c.req.param("name");
  const keys = getAvailableKeys(name);
  return c.json({
    provider: name,
    key_count: keys.length,
    has_keys: keys.length > 0,
    key_preview: keys.map((k) => k.length > 14 ? `${k.slice(0, 10)}...${k.slice(-4)}` : "***"),
  });
});

// Export
app.post("/api/export", (c) => {
  const providers = loadAllProviders();
  const modelNames = loadAllModelNames();
  const models = modelNames.map((n) => loadModelConfig(n)).filter(Boolean);

  // Gather env vars
  const envVars: Record<string, string> = {};
  const importantVars = ["CLIENT_API_KEY", "KEY_COOLDOWN_SECONDS", "MAX_KEY_RETRY_CYCLES", "LOG_LEVEL", "VERBOSE_HTTP_ERRORS", "CORS_ORIGINS"];
  for (const v of importantVars) {
    const val = process.env[v];
    if (val) envVars[v] = val;
  }

  return c.json({
    version: "1.0.0",
    exported_at: new Date().toISOString(),
    setup: { providers: Object.values(providers), models, environment: envVars },
  });
});

// Import
app.post("/api/import", async (c) => {
  const data = await c.req.json();
  const setup = data.setup || {};
  const results = { providers_imported: 0, models_imported: 0, errors: [] as string[] };

  const providersDir = getProvidersDir();
  const modelsDir = getModelsDir();
  mkdirSync(providersDir, { recursive: true });
  mkdirSync(modelsDir, { recursive: true });

  for (const provider of (setup.providers || [])) {
    try {
      const name = provider.name;
      if (!name) continue;
      writeFileSync(join(providersDir, `${name}.json`), JSON.stringify(provider, null, 2), "utf-8");
      results.providers_imported++;
    } catch (e: any) {
      results.errors.push(`Provider: ${e.message}`);
    }
  }

  for (const model of (setup.models || [])) {
    try {
      const name = model.logical_name;
      if (!name) continue;
      writeFileSync(join(modelsDir, `${name}.json`), JSON.stringify(model, null, 2), "utf-8");
      results.models_imported++;
    } catch (e: any) {
      results.errors.push(`Model: ${e.message}`);
    }
  }

  // Apply env vars
  for (const [key, value] of Object.entries(setup.environment || {})) {
    if (typeof value === "string") process.env[key] = value;
  }

  return c.json(results);
});

// Templates
app.get("/api/templates", (c) => {
  const templates: Record<string, any> = {};
  for (const root of getConfigSearchPaths()) {
    const dir = join(root, "templates");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith("_template.json")) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, file), "utf-8"));
        templates[file.replace("_template.json", "")] = data;
      } catch {}
    }
  }
  return c.json({ templates, count: Object.keys(templates).length });
});

// Validate
app.post("/api/validate", (c) => {
  const errors: string[] = [];
  const providers = loadAllProviders();

  for (const [name, config] of Object.entries(providers)) {
    if (!config.endpoints?.base_url) errors.push(`Provider '${name}': missing base_url`);
    if (!config.authentication?.header_name) errors.push(`Provider '${name}': missing header_name`);
  }

  const modelNames = loadAllModelNames();
  for (const name of modelNames) {
    const config = loadModelConfig(name);
    if (!config) { errors.push(`Model '${name}': failed to load`); continue; }
    if (!config.logical_name) errors.push(`Model '${name}': missing logical_name`);
    if (!Array.isArray(config.model_routings) || config.model_routings.length === 0) {
      errors.push(`Model '${name}': empty model_routings`);
    }
  }

  return c.json(errors.length > 0
    ? { valid: false, errors }
    : { valid: true, message: `All ${Object.keys(providers).length} provider(s) and ${modelNames.length} model(s) are valid` }
  );
});

export default app;
