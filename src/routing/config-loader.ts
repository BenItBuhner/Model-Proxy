/**
 * Configuration loader for model routing.
 * Loads and caches JSON configurations from config/models/ directory.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { ModelRoutingConfigSchema } from "../types/routing.ts";
import type { ModelRoutingConfig } from "../types/routing.ts";
import { getConfigSearchPaths } from "../core/config-paths.ts";

export class ModelConfigLoader {
  private searchPaths: string[];
  private _pathsAreModelDirs: boolean;
  private _configCache: Map<string, ModelRoutingConfig> = new Map();
  private _cacheTimestamps: Map<string, number> = new Map();
  private _cachePaths: Map<string, string> = new Map();

  constructor(configDir?: string) {
    if (configDir) {
      this.searchPaths = [configDir];
      this._pathsAreModelDirs = true;
    } else {
      this.searchPaths = getConfigSearchPaths();
      this._pathsAreModelDirs = false;
    }
  }

  private findConfigPath(logicalModel: string): string | null {
    for (const root of this.searchPaths) {
      const modelsDir = this._pathsAreModelDirs ? root : join(root, "models");
      const candidate = join(modelsDir, `${logicalModel}.json`);
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  loadConfig(logicalModel: string, forceReload: boolean = false): ModelRoutingConfig {
    const configPath = this.findConfigPath(logicalModel);

    // Check cache
    if (!forceReload && this._configCache.has(logicalModel) && configPath) {
      const cachedPath = this._cachePaths.get(logicalModel);
      if (cachedPath === configPath && this.isCacheValid(logicalModel, configPath)) {
        return this._configCache.get(logicalModel)!;
      }
    }

    if (!configPath) {
      const available = this.getAvailableModels();
      throw new Error(
        `Configuration file not found for model '${logicalModel}'. ` +
        `Available models: ${available.join(", ") || "none"}`
      );
    }

    let rawConfig: Record<string, any>;
    try {
      rawConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (e: any) {
      throw new Error(`Invalid JSON in ${configPath}: ${e.message}`);
    }

    // Validate with Zod
    const parsed = ModelRoutingConfigSchema.safeParse(rawConfig);
    if (!parsed.success) {
      throw new Error(`Invalid configuration in ${configPath}: ${parsed.error.message}`);
    }
    const config = parsed.data;

    // Validate logical_name matches filename
    if (config.logical_name !== logicalModel) {
      throw new Error(
        `Logical name mismatch in ${configPath}: ` +
        `filename suggests '${logicalModel}' but config has '${config.logical_name}'`
      );
    }

    // Cache
    this._configCache.set(logicalModel, config);
    this._cacheTimestamps.set(logicalModel, Date.now());
    this._cachePaths.set(logicalModel, configPath);

    return config;
  }

  private isCacheValid(logicalModel: string, configPath: string): boolean {
    const cacheTime = this._cacheTimestamps.get(logicalModel);
    if (!cacheTime) return false;
    try {
      const fileMtime = statSync(configPath).mtimeMs;
      return cacheTime >= fileMtime;
    } catch {
      return false;
    }
  }

  getAvailableModels(): string[] {
    const models = new Set<string>();
    for (const root of this.searchPaths) {
      const modelsDir = this._pathsAreModelDirs ? root : join(root, "models");
      if (!existsSync(modelsDir)) continue;
      try {
        for (const file of readdirSync(modelsDir)) {
          if (file.endsWith(".json")) models.add(file.replace(".json", ""));
        }
      } catch {}
    }
    return [...models].sort();
  }

  clearCache(): void {
    this._configCache.clear();
    this._cacheTimestamps.clear();
    this._cachePaths.clear();
  }

  reloadConfig(logicalModel: string): ModelRoutingConfig {
    return this.loadConfig(logicalModel, true);
  }
}

// Global singleton
export const configLoader = new ModelConfigLoader();
