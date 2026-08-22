import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  ProviderConfigSchema,
  type ProviderConfig,
} from "@model-proxy/contracts/schemas/provider.ts";
import { createLogger } from "../observability/logger.ts";
import { normalizeProvider } from "./bundle-normalizer.ts";
import { getConfigSearchPaths } from "./paths.ts";

const log = createLogger("config.provider");

interface CacheEntry {
  config: ProviderConfig;
  path: string;
  mtimeMs: number;
}

export class ProviderConfigLoader {
  private readonly searchPaths: string[];
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: { configDir?: string } = {}) {
    this.searchPaths =
      options.configDir !== undefined
        ? [options.configDir]
        : getConfigSearchPaths();
  }

  private findConfigPath(provider: string): string | undefined {
    for (const root of this.searchPaths) {
      const candidate = join(root, "providers", `${provider}.json`);
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }

  loadProvider(provider: string, forceReload = false): ProviderConfig {
    const configPath = this.findConfigPath(provider);
    if (configPath === undefined) {
      throw new Error(
        `Provider configuration not found for '${provider}'. ` +
          `Searched: ${this.searchPaths.join(", ")}`,
      );
    }

    const cached = this.cache.get(provider);
    if (!forceReload && cached !== undefined && cached.path === configPath) {
      try {
        const stat = statSync(configPath);
        if (stat.mtimeMs === cached.mtimeMs) {
          return cached.config;
        }
      } catch {
        // fall through
      }
    }

    let raw: unknown;
    try {
      const text = readFileSync(configPath, "utf8");
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Invalid JSON in ${configPath}: ${(err as Error).message}`,
      );
    }

    // Rewrite deprecated enum values so configs written by older versions
    // keep loading after the schema tightened to canonical names only.
    const normalized =
      raw !== null && typeof raw === "object" && !Array.isArray(raw)
        ? normalizeProvider(raw as Record<string, unknown>).normalized
        : raw;

    const parsed = ProviderConfigSchema.safeParse(normalized);
    if (!parsed.success) {
      throw new Error(
        `Invalid provider config in ${configPath}: ${parsed.error.message}`,
      );
    }

    const stat = statSync(configPath);
    this.cache.set(provider, {
      config: parsed.data,
      path: configPath,
      mtimeMs: stat.mtimeMs,
    });

    return parsed.data;
  }

  getAvailableProviders(): string[] {
    const names = new Set<string>();
    for (const root of this.searchPaths) {
      const dir = join(root, "providers");
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
            // ignore
          }
        }
      } catch (err) {
        log.debug("failed to scan providers dir", { dir, err: String(err) });
      }
    }
    return Array.from(names).sort();
  }

  clearCache(): void {
    this.cache.clear();
  }
}

export const providerConfigLoader = new ProviderConfigLoader();
