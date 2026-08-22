import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  AudioModelRoutingConfigSchema,
  type AudioModelRoutingConfig,
} from "@model-proxy/contracts/schemas/audio-routing.ts";
import { createLogger } from "../observability/logger.ts";
import { getConfigSearchPaths } from "./paths.ts";

const log = createLogger("config.audio-model");

interface CacheEntry {
  config: AudioModelRoutingConfig;
  path: string;
  mtimeMs: number;
}

export class AudioModelConfigLoader {
  private readonly searchPaths: string[];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: { configDir?: string } = {}) {
    this.searchPaths =
      options.configDir !== undefined
        ? [options.configDir]
        : getConfigSearchPaths();
  }

  private findConfigPath(logicalModel: string): string | undefined {
    for (const root of this.searchPaths) {
      const candidate = join(root, "audio-models", `${logicalModel}.json`);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  loadConfig(logicalModel: string, forceReload = false): AudioModelRoutingConfig {
    const configPath = this.findConfigPath(logicalModel);
    if (configPath === undefined) {
      const available = this.getAvailableModels();
      throw new AudioConfigNotFoundError(
        `Audio configuration file not found for model '${logicalModel}'. ` +
          `Available audio models: ${available.length ? available.join(", ") : "(none)"}`,
        logicalModel,
      );
    }

    const cached = this.cache.get(logicalModel);
    if (!forceReload && cached !== undefined && cached.path === configPath) {
      try {
        const stat = statSync(configPath);
        if (stat.mtimeMs === cached.mtimeMs) return cached.config;
      } catch {
        // fall through and reload
      }
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new AudioConfigParseError(
        `Invalid JSON in ${configPath}: ${(err as Error).message}`,
        configPath,
      );
    }

    const parsed = AudioModelRoutingConfigSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AudioConfigValidationError(
        `Invalid audio configuration in ${configPath}: ${parsed.error.message}`,
        configPath,
        parsed.error.issues,
      );
    }

    const config = parsed.data;
    if (config.logical_name !== logicalModel) {
      throw new AudioConfigValidationError(
        `Logical name mismatch in ${configPath}: filename suggests ` +
          `'${logicalModel}' but config has '${config.logical_name}'`,
        configPath,
        [],
      );
    }

    const stat = statSync(configPath);
    this.cache.set(logicalModel, { config, path: configPath, mtimeMs: stat.mtimeMs });
    return config;
  }

  getAvailableModels(): string[] {
    const names = new Set<string>();
    for (const root of this.searchPaths) {
      const dir = join(root, "audio-models");
      if (!existsSync(dir)) continue;
      try {
        for (const entry of readdirSync(dir)) {
          if (!entry.endsWith(".json")) continue;
          const full = join(dir, entry);
          try {
            if (statSync(full).isFile()) names.add(entry.slice(0, -".json".length));
          } catch {
            // ignore unreadable entries
          }
        }
      } catch (err) {
        log.debug("failed to scan audio models dir", { dir, err: String(err) });
      }
    }
    return Array.from(names).sort();
  }

  reload(logicalModel: string): AudioModelRoutingConfig {
    return this.loadConfig(logicalModel, true);
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export class AudioConfigNotFoundError extends Error {
  constructor(
    message: string,
    readonly logicalModel: string,
  ) {
    super(message);
    this.name = "AudioConfigNotFoundError";
  }
}

export class AudioConfigParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "AudioConfigParseError";
  }
}

export class AudioConfigValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
    readonly issues: unknown[],
  ) {
    super(message);
    this.name = "AudioConfigValidationError";
  }
}

export const audioModelConfigLoader = new AudioModelConfigLoader();

