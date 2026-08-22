import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createLogger } from "../../observability/logger.ts";
import type { FusionCacheEntry, FusionRequestContext, SubTask, SubagentResult, ComplexityScore } from "./types.ts";

const log = createLogger("routing.fusion.cache");
const CACHE_SCHEMA_VERSION = 2;

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
   * Compute a stable pre-divider key from the normalized request and Fusion
   * config. This lets Fusion recollect prior subagent work before paying the
   * divider/subagent cost on repeated agent-loop turns.
   */
  computeRequestKey(ctx: FusionRequestContext): string {
    const hashInput = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      logicalModel: ctx.logicalModel,
      clientProtocol: ctx.clientProtocol,
      inputFingerprint: ctx.inputFingerprint,
      configFingerprint: stableHash(ctx.fusionConfig),
      requestShape: normalizeRequestData(ctx.requestData),
      imageDescriptions: (ctx.imageDescriptions ?? []).map((desc) => stableHash(desc)),
      messages: normalizeMessages(ctx.messages),
    };
    return stableHash(hashInput).slice(0, 32);
  }

  /**
   * Compute a cache key from the request context and sub-tasks.
   *
   * The key is an SHA-256 hash of the normalized request, config, and stable
   * sub-task descriptions, uniquely identifying a specific Fusion execution.
   */
  computeKey(ctx: FusionRequestContext, subTasks: SubTask[]): string {
    const hashInput = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      requestKey: this.computeRequestKey(ctx),
      subTasks: subTasks.map((st) => ({
        id: st.id,
        description: st.description,
        focus_area: st.focus_area,
        suggested_model_routing: st.suggested_model_routing,
      })),
    };

    return stableHash(hashInput).slice(0, 32);
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
      if ((entry.schemaVersion ?? 1) !== CACHE_SCHEMA_VERSION) {
        log.debug("fusion cache schema mismatch", { key, schemaVersion: entry.schemaVersion ?? 1 });
        return null;
      }
      log.debug("fusion cache hit", { key });
      return entry;
    } catch (err) {
      log.debug("fusion cache read failed", { key, error: String(err) });
      return null;
    }
  }

  getByRequestKey(requestKey: string): FusionCacheEntry | null {
    try {
      const pointerPath = join(this.cacheDir, `request-${requestKey}.json`);
      if (!existsSync(pointerPath)) return null;
      const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as { key?: string };
      if (typeof pointer.key !== "string" || pointer.key.length === 0) return null;
      return this.get(pointer.key);
    } catch (err) {
      log.debug("fusion request cache read failed", { requestKey, error: String(err) });
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
    requestKey?: string,
    opts?: { conversationId?: string; messages?: unknown[] },
  ): void {
    try {
      const cachePath = join(this.cacheDir, `${key}.json`);
      const entry: FusionCacheEntry = {
        schemaVersion: CACHE_SCHEMA_VERSION,
        key,
        requestKey,
        subagentResults,
        subTasks,
        complexityScore,
        createdAt: new Date().toISOString(),
        fusedContent,
        conversationId: opts?.conversationId,
        normalizedMessages: opts?.messages !== undefined ? normalizeMessages(opts.messages) : undefined,
      };

      writeFileSync(cachePath, JSON.stringify(entry, null, 2), "utf8");
      if (requestKey !== undefined) {
        this.linkRequestKey(requestKey, key);
      }
      if (opts?.conversationId !== undefined) {
        const convPath = join(this.cacheDir, `conversation-${sanitizePointerId(opts.conversationId)}.json`);
        writeFileSync(convPath, JSON.stringify({ conversationId: opts.conversationId, key, updatedAt: entry.createdAt }, null, 2), "utf8");
      }
      log.debug("fusion cache stored", {
        key,
        requestKey,
        conversationId: opts?.conversationId,
        subagentCount: subagentResults.length,
        subTaskCount: subTasks.length,
      });
    } catch (err) {
      log.warn("failed to write fusion cache", { key, error: String(err) });
    }
  }

  /** Point a pre-divider request key at an existing cache entry. */
  linkRequestKey(requestKey: string, key: string): void {
    try {
      const pointerPath = join(this.cacheDir, `request-${requestKey}.json`);
      writeFileSync(pointerPath, JSON.stringify({ requestKey, key, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    } catch (err) {
      log.warn("failed to link fusion request key", { requestKey, key, error: String(err) });
    }
  }

  /**
   * Conversation-prefix reuse: find the most recent entry for this
   * conversation whose messages are a prefix of the current messages, and
   * decide whether the appended delta is trivial enough to reuse the prior
   * deep reasoning instead of respawning subagents.
   *
   * Returns null when there is no matching entry OR the delta contains
   * significant new information (new user instruction, file contents/code in
   * tool results, images, errors) — in which case subagents should respawn.
   */
  findConversationReuse(ctx: FusionRequestContext): ConversationReuse | null {
    const conversationId = ctx.conversationId;
    if (conversationId === undefined || conversationId.length === 0) return null;
    try {
      const convPath = join(this.cacheDir, `conversation-${sanitizePointerId(conversationId)}.json`);
      if (!existsSync(convPath)) return null;
      const pointer = JSON.parse(readFileSync(convPath, "utf8")) as { key?: string };
      if (typeof pointer.key !== "string" || pointer.key.length === 0) return null;
      const entry = this.get(pointer.key);
      if (!entry || entry.normalizedMessages === undefined) return null;

      const currentNormalized = normalizeMessages(ctx.messages);
      if (entry.normalizedMessages.length > currentNormalized.length) return null;

      // Prefix check: every stored normalized message must match positionally
      for (let i = 0; i < entry.normalizedMessages.length; i++) {
        if (stableStringify(entry.normalizedMessages[i]) !== stableStringify(currentNormalized[i])) {
          return null;
        }
      }

      const deltaMessages = ctx.messages.slice(entry.normalizedMessages.length);
      const classification = classifyConversationDelta(ctx.messages, deltaMessages);
      if (classification.significant) {
        log.info("conversation delta significant — respawning subagents", {
          conversationId,
          deltaCount: deltaMessages.length,
          reason: classification.reason,
        });
        return null;
      }

      log.info("conversation delta trivial — reusing prior subagent reasoning", {
        conversationId,
        key: entry.key,
        deltaCount: deltaMessages.length,
        reason: classification.reason,
      });
      return { entry, deltaCount: deltaMessages.length, reason: classification.reason };
    } catch (err) {
      log.debug("fusion conversation reuse lookup failed", { conversationId, error: String(err) });
      return null;
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
      const files = readdirSync(this.cacheDir).filter((f) => f.endsWith(".json") && !f.startsWith("request-"));
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
      return readdirSync(this.cacheDir).filter((f) => f.endsWith(".json") && !f.startsWith("request-")).length;
    } catch {
      return 0;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

}

export interface ConversationReuse {
  entry: FusionCacheEntry;
  deltaCount: number;
  reason: string;
}

export interface DeltaClassification {
  significant: boolean;
  reason: string;
}

function sanitizePointerId(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}

const TRIVIAL_TOOL_NAME = /todo|plan|task[-_]?list|update[-_]?plan/i;
const CONTEXT_TOOL_NAME = /read|grep|search|find|list|glob|cat|sed|show|diff|status|log|ls|file|shell|bash|exec|run|test/i;
const CODE_FENCE = /```/;
const FILE_PATH = /(^|[\s"'`(=])(\/|\.\.?\/|~\/|[A-Za-z]:\\|[\w.-]+\/)[\w.\\/-]*\w\.\w{1,8}\b/m;
const DIFF_OR_PATCH_SIGNAL = /(^|\n)\s*(diff --git|@@ |[+-]{3} |\+\+\+ |--- )/;
const CODE_LIKE_SIGNAL = /\b(export|import|const|let|function|class|interface|type|return|async|await|SELECT|INSERT|UPDATE|CREATE TABLE)\b|[{};]\s*$/m;
// Matches error signals including compound words like "TypeError" / "SyntaxError".
const ERROR_SIGNAL = /\b\w*(error|exception)s?\b|traceback|stack trace|\bfail(ed|ure|ing)?\b|\bpanic\b|segfault/i;

const ACK_WORDS = new Set([
  "ok", "okay", "yes", "yep", "yeah", "no", "nope", "sure", "thanks", "thank", "you",
  "got", "it", "sounds", "good", "continue", "proceed", "keep", "going", "go", "on",
  "ahead", "do", "next", "done", "nice", "great", "cool", "lgtm", "perfect", "please",
]);

/** True when a short user message is just an acknowledgment / continue nudge. */
function isAcknowledgment(text: string): boolean {
  if (text.length > 80) return false;
  const words = text.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 0);
  if (words.length === 0) return true;
  return words.every((word) => ACK_WORDS.has(word));
}

/** Extract all plain text from a message's content (string or parts array). */
function extractMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const obj = message as Record<string, unknown>;
  const content = obj["content"];
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (typeof p["text"] === "string") parts.push(p["text"]);
    if (p["type"] === "tool_result") {
      const inner = p["content"];
      if (typeof inner === "string") parts.push(inner);
      else if (Array.isArray(inner)) {
        for (const ip of inner) {
          const ipo = ip as Record<string, unknown>;
          if (typeof ipo?.["text"] === "string") parts.push(ipo["text"] as string);
        }
      }
    }
  }
  return parts.join("\n");
}

function messageHasImages(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    const p = part as Record<string, unknown>;
    return p?.["type"] === "image_url" || p?.["type"] === "image";
  });
}

/** Map tool_call_id → function name across the full conversation. */
function buildToolNameMap(allMessages: unknown[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of allMessages) {
    if (typeof message !== "object" || message === null) continue;
    const obj = message as Record<string, unknown>;
    const toolCalls = obj["tool_calls"];
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const tco = tc as Record<string, unknown>;
      const id = typeof tco?.["id"] === "string" ? (tco["id"] as string) : undefined;
      const fn = tco?.["function"] as Record<string, unknown> | undefined;
      const name = typeof fn?.["name"] === "string" ? (fn["name"] as string) : undefined;
      if (id !== undefined && name !== undefined) map.set(id, name);
    }
  }
  return map;
}

/**
 * Classify the appended conversation delta as trivial (safe to reuse prior
 * deep reasoning) or significant (new revelations — respawn subagents).
 *
 * Significant: substantial new user instructions, tool results carrying file
 * contents / code / errors, or new images.
 * Trivial: todo/plan tool activity, short acknowledgments, small
 * confirmation-style tool results, and the assistant's own messages.
 */
export function classifyConversationDelta(
  allMessages: unknown[],
  deltaMessages: unknown[],
): DeltaClassification {
  if (deltaMessages.length === 0) {
    return { significant: false, reason: "no new messages" };
  }

  const toolNames = buildToolNameMap(allMessages);

  for (const message of deltaMessages) {
    if (typeof message !== "object" || message === null) continue;
    const obj = message as Record<string, unknown>;
    const role = typeof obj["role"] === "string" ? (obj["role"] as string) : "";

    if (messageHasImages(message)) {
      return { significant: true, reason: "new image content" };
    }

    const text = extractMessageText(message);

    if (role === "user") {
      // In OpenAI-style agent loops tool results sometimes arrive as user
      // messages with tool_result parts — handle those as tool results.
      const looksLikeToolResult = Array.isArray(obj["content"]) &&
        (obj["content"] as Array<Record<string, unknown>>).some((p) => p?.["type"] === "tool_result");
      if (!looksLikeToolResult) {
        const trimmed = text.trim();
        if (trimmed.length > 0 && !isAcknowledgment(trimmed)) {
          return { significant: true, reason: "new user instruction" };
        }
        continue;
      }
      if (isSignificantToolResult(text)) {
        return { significant: true, reason: "substantial tool result content" };
      }
      continue;
    }

    if (role === "tool") {
      const toolCallId = typeof obj["tool_call_id"] === "string" ? (obj["tool_call_id"] as string) : undefined;
      const name = (typeof obj["name"] === "string" ? (obj["name"] as string) : undefined) ??
        (toolCallId !== undefined ? toolNames.get(toolCallId) : undefined);
      if (name !== undefined && TRIVIAL_TOOL_NAME.test(name)) continue;
      if (isSignificantToolResult(text, name)) {
        return { significant: true, reason: `substantial tool result${name !== undefined ? ` (${name})` : ""}` };
      }
      continue;
    }

    // Assistant messages (including its own tool_calls) carry no new external
    // information — the reasoning that produced them is already cached.
  }

  return { significant: false, reason: "only trivial updates (todo/plan, acks, small tool results)" };
}

function isSignificantToolResult(text: string, toolName?: string): boolean {
  if (text.length > 1500) return true;
  if (CODE_FENCE.test(text)) return true;
  if (ERROR_SIGNAL.test(text)) return true;
  if (DIFF_OR_PATCH_SIGNAL.test(text)) return true;
  if (text.length > 300 && FILE_PATH.test(text)) return true;
  if (toolName !== undefined && CONTEXT_TOOL_NAME.test(toolName)) {
    if (FILE_PATH.test(text)) return true;
    if (CODE_LIKE_SIGNAL.test(text)) return true;
  }
  return false;
}

function normalizeRequestData(requestData: Record<string, unknown>): Record<string, unknown> {
  return {
    model: requestData["model"],
    max_tokens: requestData["max_tokens"],
    temperature: requestData["temperature"],
    top_p: requestData["top_p"],
    tool_choice: requestData["tool_choice"],
    tools_hash: requestData["tools"] === undefined ? undefined : stableHash(requestData["tools"]),
    response_format: requestData["response_format"],
  };
}

function normalizeMessages(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
    const obj = message as Record<string, unknown>;
    return {
      role: obj["role"],
      content: normalizeContent(obj["content"]),
      tool_calls_hash: obj["tool_calls"] === undefined ? undefined : stableHash(obj["tool_calls"]),
      tool_call_id: obj["tool_call_id"],
      name: obj["name"],
    };
  });
}

function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return part;
    const obj = part as Record<string, unknown>;
    if (obj["type"] === "tool_result") {
      return { ...obj, content_hash: stableHash(obj["content"]), content: undefined };
    }
    if (obj["type"] === "image_url") {
      return { type: "image_url", image_hash: stableHash(obj["image_url"]) };
    }
    return obj;
  });
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}
