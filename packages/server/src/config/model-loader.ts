import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ModelRoutingConfigSchema,
  type ModelRoutingConfig,
} from "@model-proxy/contracts/schemas/routing.ts";
import { createLogger } from "../observability/logger.ts";
import { getConfigSearchPaths } from "./paths.ts";

const log = createLogger("config.model");

interface CacheEntry {
  config: ModelRoutingConfig;
  path: string;
  mtimeMs: number;
}

export class ModelConfigLoader {
  private readonly searchPaths: string[];
  private readonly pathsArePlainModelDirs: boolean;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: { configDir?: string } = {}) {
    if (options.configDir !== undefined) {
      this.searchPaths = [options.configDir];
      this.pathsArePlainModelDirs = true;
    } else {
      this.searchPaths = getConfigSearchPaths();
      this.pathsArePlainModelDirs = false;
    }
  }

  private findConfigPath(logicalModel: string): string | undefined {
    for (const root of this.searchPaths) {
      const candidate = this.pathsArePlainModelDirs
        ? join(root, `${logicalModel}.json`)
        : join(root, "models", `${logicalModel}.json`);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  private modelsDir(root: string): string {
    return this.pathsArePlainModelDirs ? root : join(root, "models");
  }

  loadConfig(logicalModel: string, forceReload = false): ModelRoutingConfig {
    const configPath = this.findConfigPath(logicalModel);
    if (configPath === undefined) {
      const available = this.getAvailableModels();
      throw new ConfigNotFoundError(
        `Configuration file not found for model '${logicalModel}'. ` +
          `Available models: ${available.length ? available.join(", ") : "(none)"}`,
        logicalModel,
      );
    }

    const cached = this.cache.get(logicalModel);
    if (!forceReload && cached !== undefined && cached.path === configPath) {
      try {
        const stat = statSync(configPath);
        if (stat.mtimeMs === cached.mtimeMs) {
          return cached.config;
        }
      } catch {
        // fall through and reload
      }
    }

    let raw: unknown;
    try {
      const text = readFileSync(configPath, "utf8");
      raw = JSON.parse(text);
    } catch (err) {
      throw new ConfigParseError(
        `Invalid JSON in ${configPath}: ${(err as Error).message}`,
        configPath,
      );
    }

    const parsed = ModelRoutingConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigValidationError(
        `Invalid configuration in ${configPath}: ${parsed.error.message}`,
        configPath,
        parsed.error.issues,
      );
    }

    const config = parsed.data;

    if (config.logical_name !== logicalModel) {
      throw new ConfigValidationError(
        `Logical name mismatch in ${configPath}: filename suggests ` +
          `'${logicalModel}' but config has '${config.logical_name}'`,
        configPath,
        [],
      );
    }

    const stat = statSync(configPath);
    this.cache.set(logicalModel, {
      config,
      path: configPath,
      mtimeMs: stat.mtimeMs,
    });

    return config;
  }

  getAvailableModels(): string[] {
    const names = new Set<string>();
    for (const root of this.searchPaths) {
      const dir = this.modelsDir(root);
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith(".json")) continue;
          const full = join(dir, entry);
          try {
            const stat = statSync(full);
            if (stat.isFile()) {
              names.add(entry.slice(0, -".json".length));
            }
          } catch {
            // ignore unreadable entries
          }
        }
      } catch (err) {
        log.debug("failed to scan models dir", { dir, err: String(err) });
      }
    }
    return Array.from(names).sort();
  }

  reload(logicalModel: string): ModelRoutingConfig {
    return this.loadConfig(logicalModel, true);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export class ConfigNotFoundError extends Error {
  constructor(
    message: string,
    readonly logicalModel: string,
  ) {
    super(message);
    this.name = "ConfigNotFoundError";
  }
}

export class ConfigParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "ConfigParseError";
  }
}

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: unknown[],
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export const modelConfigLoader = new ModelConfigLoader();
