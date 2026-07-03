import { createLogger } from "../../observability/logger.ts";
import { WasmExecutor } from "./sandbox/wasm-executor.ts";
import { FetchShim } from "./sandbox/fetch-shim.ts";
import type { CodeLanguage } from "./sandbox/types.ts";

const log = createLogger("routing.fusion.subagent-tools");

/** Config-level tool identifiers (shared/schemas/fusion.ts effort_levels[].tools). */
export type FusionToolId = "context_search" | "web_search" | "code_execution";

/** Max characters returned from any single tool execution. */
const MAX_TOOL_RESULT_CHARS = 16_000;

/** Max characters returned from a fetched web page. */
const MAX_PAGE_CHARS = 8_000;

/** Timeout for sandboxed code execution. */
const CODE_EXECUTION_TIMEOUT_MS = 20_000;

/** Browser-like User-Agent used for search/page fetches. */
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ── Tool schemas ──────────────────────────────────────────────────────

const SEARCH_CONTEXT_SCHEMA = {
  type: "function",
  function: {
    name: "search_context",
    description:
      "Search the full conversation context (all prior messages, tool results, and code) for relevant information. Returns the most relevant excerpts. Use this to ground your analysis in what actually happened in the conversation.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords to search the conversation for" },
      },
      required: ["query"],
    },
  },
};

const WEB_SEARCH_SCHEMA = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "Search the public web for up-to-date documentation, references, or facts. Returns result titles, URLs, and snippets. Research-only: results inform your written analysis.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Web search query" },
      },
      required: ["query"],
    },
  },
};

const FETCH_URL_SCHEMA = {
  type: "function",
  function: {
    name: "fetch_url",
    description:
      "Fetch a public web page or raw file by URL and return its readable text content. Use after web_search to read a promising result in depth.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch" },
      },
      required: ["url"],
    },
  },
};

const EXECUTE_CODE_SCHEMA = {
  type: "function",
  function: {
    name: "execute_code",
    description:
      "Run a short snippet of code in an isolated scratch sandbox to verify reasoning (calculations, algorithm checks, parsing experiments). The sandbox has NO access to the user's project, filesystem, or environment — it is a blank interpreter for research only.",
    parameters: {
      type: "object",
      properties: {
        language: { type: "string", enum: ["python", "javascript", "typescript"], description: "Language of the snippet" },
        code: { type: "string", description: "Self-contained code snippet to execute" },
      },
      required: ["language", "code"],
    },
  },
};

// ── Helpers ───────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[...truncated ${text.length - max} chars]`;
}

/** Strip HTML tags and collapse whitespace into readable text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/**
 * Keyword-match search across conversation messages, returning the most
 * relevant excerpts. Shared by the task divider and subagent toolbox.
 */
export function searchConversationContext(messages: unknown[], query: string): string {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2);
  if (terms.length === 0) return "No query terms provided.";

  const scored: Array<{ index: number; role: string; text: string; score: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const obj = messages[i] as Record<string, unknown>;
    const text = typeof obj?.["content"] === "string"
      ? (obj["content"] as string)
      : JSON.stringify(obj?.["content"] ?? "");
    const lower = text.toLowerCase();
    const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
    if (score > 0) {
      scored.push({ index: i, role: String(obj?.["role"] ?? "unknown"), text, score });
    }
  }

  if (scored.length === 0) return `No conversation messages matched "${query}".`;

  scored.sort((a, b) => b.score - a.score);
  const excerpts = scored.slice(0, 5).map((hit) => {
    const firstTerm = terms.find((t) => hit.text.toLowerCase().includes(t)) ?? terms[0];
    const at = Math.max(0, hit.text.toLowerCase().indexOf(firstTerm) - 150);
    const excerpt = hit.text.slice(at, at + 450);
    return `[message ${hit.index + 1}, role=${hit.role}, matched ${hit.score}/${terms.length} terms]\n...${excerpt}...`;
  });
  return excerpts.join("\n\n");
}

// ── ResearchToolbox ───────────────────────────────────────────────────

/**
 * Local execution backend for the research tools available to Fusion
 * subagents. All tools run inside the proxy process (or its sandbox) —
 * subagent models NEVER touch the client's environment.
 *
 * Which tools are exposed is driven by the effort-level `tools` config:
 *   - context_search → search_context
 *   - web_search     → web_search + fetch_url
 *   - code_execution → execute_code (sandboxed scratch interpreter)
 */
export class ResearchToolbox {
  private readonly enabled: Set<FusionToolId>;
  private readonly messages: unknown[];
  private readonly fetchShim: FetchShim;
  private readonly codeExecutor: WasmExecutor;

  constructor(messages: unknown[], enabledTools: readonly string[]) {
    this.messages = messages;
    this.enabled = new Set(enabledTools.filter((t): t is FusionToolId =>
      t === "context_search" || t === "web_search" || t === "code_execution"));
    this.fetchShim = new FetchShim();
    this.codeExecutor = new WasmExecutor({ timeoutMs: CODE_EXECUTION_TIMEOUT_MS });
  }

  /** OpenAI-format tool schemas for the enabled research tools. */
  get schemas(): unknown[] {
    const schemas: unknown[] = [];
    if (this.enabled.has("context_search")) schemas.push(SEARCH_CONTEXT_SCHEMA);
    if (this.enabled.has("web_search")) {
      schemas.push(WEB_SEARCH_SCHEMA);
      schemas.push(FETCH_URL_SCHEMA);
    }
    if (this.enabled.has("code_execution")) schemas.push(EXECUTE_CODE_SCHEMA);
    return schemas;
  }

  /** Human-readable list of enabled tool names (for prompts). */
  get toolNames(): string[] {
    return (this.schemas as Array<{ function: { name: string } }>).map((s) => s.function.name);
  }

  has(name: string): boolean {
    return this.toolNames.includes(name);
  }

  /**
   * Execute a research tool call. Never throws — failures come back as
   * readable tool-result text so the subagent can adapt and keep reasoning.
   */
  async execute(name: string, argumentsJson: string): Promise<string> {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(argumentsJson || "{}") as Record<string, unknown>;
    } catch {
      return `Could not parse arguments for ${name}: invalid JSON. Re-issue the call with valid JSON arguments.`;
    }

    try {
      switch (name) {
        case "search_context":
          return truncate(searchConversationContext(this.messages, String(args["query"] ?? "")), MAX_TOOL_RESULT_CHARS);
        case "web_search":
          return truncate(await this.webSearch(String(args["query"] ?? "")), MAX_TOOL_RESULT_CHARS);
        case "fetch_url":
          return truncate(await this.fetchUrl(String(args["url"] ?? "")), MAX_TOOL_RESULT_CHARS);
        case "execute_code":
          return truncate(
            await this.executeCode(String(args["language"] ?? "python"), String(args["code"] ?? "")),
            MAX_TOOL_RESULT_CHARS,
          );
        default:
          return this.unavailableToolMessage(name);
      }
    } catch (err) {
      log.warn("research tool execution failed", { tool: name, error: String(err) });
      return `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}. Continue your analysis with the information you already have.`;
    }
  }

  /**
   * Standard rejection message for tools the subagent hallucinated
   * (e.g. file editors or shells it saw in the conversation transcript).
   */
  unavailableToolMessage(name: string): string {
    const available = this.toolNames;
    const availableText = available.length > 0
      ? `The ONLY tools available to you are: ${available.join(", ")}.`
      : "You have NO tools available.";
    return `The tool "${name}" does not exist in this research sandbox. You are an isolated research/reasoning subagent — you cannot edit files, run project commands, or take any real-world actions. ${availableText} Write your findings and recommendations as plain text; a separate synthesis model performs any real actions.`;
  }

  // ── Tool implementations ──────────────────────────────────────────

  private async webSearch(query: string): Promise<string> {
    if (query.trim().length === 0) return "Empty web_search query.";

    // Engines in preference order — scraping-tolerant first. DDG endpoints
    // frequently answer with a bot-challenge page from datacenter IPs.
    const engines: Array<{ name: string; run: () => Promise<Array<{ title: string; url: string; snippet: string }>> }> = [
      { name: "mojeek", run: () => this.searchMojeek(query) },
      { name: "ddg-lite", run: () => this.searchDuckDuckGoLite(query) },
    ];

    for (const engine of engines) {
      try {
        const results = await engine.run();
        if (results.length > 0) {
          return results
            .slice(0, 8)
            .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`)
            .join("\n\n");
        }
        log.debug("web search engine returned no results", { engine: engine.name, query });
      } catch (err) {
        log.warn("web search engine failed", { engine: engine.name, query, error: String(err) });
      }
    }
    return `No web results found for "${query}". Continue with the information you already have.`;
  }

  private async searchMojeek(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const response = await this.fetchShim.fetch(
      `https://www.mojeek.com/search?q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" } },
    );
    if (!response.ok) return [];
    const html = response.body;
    const results: Array<{ title: string; url: string; snippet: string }> = [];

    const titlePattern = /<h2>\s*<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern = /<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/gi;
    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snippetPattern.exec(html)) !== null) {
      snippets.push(htmlToText(sm[1]));
    }
    let tm: RegExpExecArray | null;
    while ((tm = titlePattern.exec(html)) !== null && results.length < 10) {
      const title = htmlToText(tm[2]);
      if (title.length === 0) continue;
      results.push({ title, url: tm[1], snippet: snippets[results.length] ?? "" });
    }
    return results;
  }

  private async searchDuckDuckGoLite(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
    const response = await this.fetchShim.fetch(
      `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html" } },
    );
    if (!response.ok) return [];
    if (/anomaly-modal|challenge-form|bots use DuckDuckGo/i.test(response.body)) {
      log.debug("duckduckgo lite served a bot challenge; skipping");
      return [];
    }
    return this.parseDuckDuckGoLite(response.body);
  }

  private parseDuckDuckGoLite(html: string): Array<{ title: string; url: string; snippet: string }> {
    const results: Array<{ title: string; url: string; snippet: string }> = [];
    const linkPattern = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

    const snippets: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = snippetPattern.exec(html)) !== null) {
      snippets.push(htmlToText(sm[1]));
    }

    let lm: RegExpExecArray | null;
    while ((lm = linkPattern.exec(html)) !== null && results.length < 10) {
      const rawUrl = lm[1] ?? lm[3] ?? "";
      const rawTitle = lm[2] ?? lm[4] ?? "";
      const title = htmlToText(rawTitle);
      let resolved = rawUrl;
      // DDG lite wraps result URLs as //duckduckgo.com/l/?uddg=<encoded>
      const uddg = rawUrl.match(/[?&]uddg=([^&]+)/);
      if (uddg) {
        try {
          resolved = decodeURIComponent(uddg[1]);
        } catch { /* keep wrapped URL */ }
      }
      if (title.length === 0 || resolved.length === 0) continue;
      if (resolved.startsWith("//")) resolved = `https:${resolved}`;
      if (!/^https?:\/\//i.test(resolved)) continue;
      results.push({ title, url: resolved, snippet: snippets[results.length] ?? "" });
    }
    return results;
  }

  private async fetchUrl(url: string): Promise<string> {
    if (!/^https?:\/\//i.test(url)) {
      return `fetch_url requires an absolute http(s) URL; got "${url}".`;
    }
    const response = await this.fetchShim.fetch(url, {
      headers: { "User-Agent": BROWSER_USER_AGENT },
    });
    if (!response.ok) {
      return `Fetch failed for ${url} (HTTP ${response.status}).`;
    }
    const contentType = response.headers["content-type"] ?? "";
    const text = contentType.includes("html") ? htmlToText(response.body) : response.body;
    return truncate(text, MAX_PAGE_CHARS);
  }

  private async executeCode(language: string, code: string): Promise<string> {
    if (code.trim().length === 0) return "Empty code snippet.";
    const lang: CodeLanguage = language === "javascript" || language === "typescript" ? language : "python";
    const result = await this.codeExecutor.execute({ code, language: lang });
    const parts: string[] = [`exit_code: ${result.exitCode} (${result.success ? "success" : "failure"}), ${result.durationMs}ms`];
    if (result.stdout.trim().length > 0) parts.push(`stdout:\n${truncate(result.stdout, 6000)}`);
    if (result.stderr.trim().length > 0) parts.push(`stderr:\n${truncate(result.stderr, 3000)}`);
    if (result.error) parts.push(`error: ${result.error}`);
    return parts.join("\n\n");
  }
}
