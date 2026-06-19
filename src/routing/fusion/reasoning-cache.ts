import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../../observability/logger.ts";
import type { FusionCacheEntry, FusionRequestContext, SubTask, SubagentResult, ComplexityScore } from "./types.ts";

const log = createLogger("routing.fusion.cache");

/**
 * Default cache directory.
 */
const DEFAULT_CACHE_DIR = join(
  process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "/tmp", ".local", "share"),
  "model-proxy",
  "fusion-cache",
);

// ── ReasoningCache ────────────────────────────────────────────────────

/**
 * Layer 1: Reasoning Cache
 *
 * Permanently caches fusion subagent results keyed by a hash of
 * (system prompt + conversation prefix + sub-tasks).
 *
 * On cache hit, the cached subagent outputs can be reconstructed and
 * appended above the final fusion response, avoiding re-execution of
 * identical sub-tasks.
 */
export class ReasoningCache {
  private readonly cacheDir: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir ?? DEFAULT_CACHE_DIR;
    if (!existsSync(this.cacheDir)) {
      try {
        mkdirSync(this.cacheDir, { recursive: true });
      } catch (err) {
        log.warn("failed to create fusion cache directory", { error: String(err) });
      }
    }
  }

  /**
   * Compute a cache key from the request context and sub-tasks.
   *
   * The key is an SHA-256 hash of (system prompt + conversation messages +
   * sub-task descriptions), uniquely identifying a specific fusion execution.
   */
  computeKey(ctx: FusionRequestContext, subTasks: SubTask[]): string {
    const { messages } = ctx;

    const hashInput = JSON.stringify({
      systemPrompt: this.extractSystemPrompt(messages),
      messages: messages.slice(-10), // Recent conversation context
      subTasks: subTasks.map((st) => ({
        description: st.description,
        focus_area: st.focus_area,
      })),
    });

    return createHash("sha256").update(hashInput).digest("hex").slice(0, 32);
  }

  /**
   * Try to retrieve cached subagent results for a given key.
   * Returns null on cache miss.
   */
  get(key: string): FusionCacheEntry | null {
    try {
      const cachePath = join(this.cacheDir, `${key}.json`);
      if (!existsSync(cachePath)) {
        return null;
      }

      const data = readFileSync(cachePath, "utf8");
      const entry = JSON.parse(data) as FusionCacheEntry;
      log.debug("fusion cache hit", { key });
      return entry;
    } catch (err) {
      log.debug("fusion cache read failed", { key, error: String(err) });
      return null;
    }
  }

  /**
   * Check if a cache entry exists without loading the full content.
   */
  has(key: string): boolean {
    const cachePath = join(this.cacheDir, `${key}.json`);
    return existsSync(cachePath);
  }

  /**
   * Store subagent results in the permanent cache.
   */
  set(
    key: string,
    subagentResults: SubagentResult[],
    subTasks: SubTask[],
    complexityScore: ComplexityScore,
    fusedContent?: string,
  ): void {
    try {
      const cachePath = join(this.cacheDir, `${key}.json`);
      const entry: FusionCacheEntry = {
        key,
        subagentResults,
        subTasks,
        complexityScore,
        createdAt: new Date().toISOString(),
        fusedContent,
      };

      writeFileSync(cachePath, JSON.stringify(entry, null, 2), "utf8");
      log.debug("fusion cache stored", {
        key,
        subagentCount: subagentResults.length,
        subTaskCount: subTasks.length,
      });
    } catch (err) {
      log.warn("failed to write fusion cache", { key, error: String(err) });
    }
  }

  /**
   * Delete a specific cache entry.
   */
  delete(key: string): void {
    try {
      const cachePath = join(this.cacheDir, `${key}.json`);
      if (existsSync(cachePath)) {
        // Use unlinkSync via dynamic import to avoid type issues
        const fs = require("node:fs");
        fs.unlinkSync(cachePath);
        log.debug("fusion cache deleted", { key });
      }
    } catch (err) {
      log.warn("failed to delete fusion cache", { key, error: String(err) });
    }
  }

  /**
   * List all cache entries (keys and metadata).
   */
  list(): Array<{ key: string; createdAt: string; subTasks: number; subagentResults: number }> {
    try {
      if (!existsSync(this.cacheDir)) return [];
      const files = readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"));
      const entries: Array<{ key: string; createdAt: string; subTasks: number; subagentResults: number }> = [];

      for (const file of files) {
        try {
          const data = readFileSync(join(this.cacheDir, file), "utf8");
          const entry = JSON.parse(data) as FusionCacheEntry;
          entries.push({
            key: entry.key,
            createdAt: entry.createdAt,
            subTasks: entry.subTasks.length,
            subagentResults: entry.subagentResults.length,
          });
        } catch {
          // Skip corrupted entries
        }
      }

      return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch (err) {
      log.warn("failed to list fusion cache", { error: String(err) });
      return [];
    }
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    try {
      if (!existsSync(this.cacheDir)) return;
      const files = readdirSync(this.cacheDir).filter((f) => f.endsWith(".json"));
      const fs = require("node:fs");
      for (const file of files) {
        fs.unlinkSync(join(this.cacheDir, file));
      }
      log.info("fusion cache cleared", { count: files.length });
    } catch (err) {
      log.warn("failed to clear fusion cache", { error: String(err) });
    }
  }

  /**
   * Get the total count of cache entries.
   */
  get size(): number {
    try {
      if (!existsSync(this.cacheDir)) return 0;
      return readdirSync(this.cacheDir).filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private extractSystemPrompt(messages: unknown[]): string {
    for (const msg of messages) {
      const m = msg as Record<string, unknown>;
      if (m["role"] === "system" && typeof m["content"] === "string") {
        return m["content"];
      }
    }
    return "";
  }
}
