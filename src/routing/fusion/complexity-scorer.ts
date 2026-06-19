import { createLogger } from "../../observability/logger.ts";
import type { FusionRequestContext, ComplexityScore, EffortLevel } from "./types.ts";

const log = createLogger("routing.fusion.complexity");

/**
 * Token estimation: rough heuristic (chars / 4), mirroring
 * the estimate used elsewhere in the proxy.
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Estimate total tokens from the full request messages array.
 */
function estimateTotalTokens(messages: unknown[]): number {
  let total = 0;
  for (const msg of messages) {
    const content = (msg as Record<string, unknown>)["content"];
    if (typeof content === "string") {
      total += estimateTokenCount(content);
    } else if (Array.isArray(content)) {
      for (const part of content) {
        const partObj = part as Record<string, unknown>;
        if (typeof partObj["text"] === "string") {
          total += estimateTokenCount(partObj["text"]);
        }
      }
    }
  }
  return total;
}

/**
 * Count tool definitions in the request.
 * Checks both message-level tools and request-level tools array.
 */
function countTools(messages: unknown[], requestData?: Record<string, unknown>): number {
  let count = 0;

  // Check request-level tools array (OpenAI API format)
  if (requestData && Array.isArray(requestData["tools"])) {
    count += (requestData["tools"] as unknown[]).length;
  }

  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m["tools"] && Array.isArray(m["tools"])) {
      count += m["tools"].length;
    }
    // Also check for tool_use content blocks (Anthropic format)
    if (Array.isArray(m["content"])) {
      for (const part of m["content"]) {
        const p = part as Record<string, unknown>;
        if (p["type"] === "tool_use" || p["type"] === "tool_result") {
          count += 1;
        }
      }
    }
    // Count function/tool calls in OpenAI format
    if (m["tool_calls"] && Array.isArray(m["tool_calls"])) {
      count += m["tool_calls"].length;
    }
    if (m["function_call"] !== undefined) {
      count += 1;
    }
  }
  return count;
}

/**
 * Count conversation turns (user ↔ assistant pairs).
 */
function countConversationTurns(messages: unknown[]): number {
  let turns = 0;
  let lastRole = "";
  for (const msg of messages) {
    const role = (msg as Record<string, unknown>)["role"] as string | undefined;
    if (role === "user" && lastRole === "assistant") {
      turns += 1;
    } else if (role === "user") {
      // First user message starts turn counting
    }
    lastRole = role ?? "";
  }
  return Math.max(1, turns);
}

/**
 * Heuristic: does the task involve code generation?
 * Scans messages for code-related keywords.
 */
function hasCodeGeneration(messages: unknown[]): boolean {
  const codeKeywords = [
    "implement", "function", "class ", "def ", "const ", "let ", "import ",
    "require(", "component", "api", "endpoint", "database", "schema",
    "algorithm", "optimize", "refactor", "bug", "error",
  ];
  const text = JSON.stringify(messages).toLowerCase();
  let matches = 0;
  for (const keyword of codeKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      matches += 1;
    }
  }
  return matches >= 2;
}

/**
 * Heuristic: does the task involve open-ended reasoning or research?
 */
function hasOpenEndedReasoning(messages: unknown[]): boolean {
  const reasoningKeywords = [
    "explain", "analyze", "compare", "contrast", "research", "investigate",
    "why", "how does", "what is the best", "evaluate", "assess",
    "design", "architect", "plan", "strategy",
  ];
  const text = JSON.stringify(messages).toLowerCase();
  let matches = 0;
  for (const keyword of reasoningKeywords) {
    if (text.includes(keyword.toLowerCase())) {
      matches += 1;
    }
  }
  return matches >= 2;
}

/**
 * ComplexityScorer (Layer 2)
 *
 * Analyzes the incoming request and assigns a complexity score (0-1)
 * which determines the effort level for fusion routing.
 *
 * Scoring dimensions:
 *  - Token count (weight: high)
 *  - Tool count (weight: medium)
 *  - Conversation turns (weight: medium)
 *  - Code generation presence (weight: medium)
 *  - Open-ended reasoning presence (weight: low)
 */
export class ComplexityScorer {
  /**
   * Score a fusion request and return the complexity assessment.
   */
  score(ctx: FusionRequestContext): ComplexityScore {
    const { messages, fusionConfig, requestData } = ctx;
    const tokenCount = estimateTotalTokens(messages);
    const toolCount = countTools(messages, requestData);
    const turns = countConversationTurns(messages);
    const hasCode = hasCodeGeneration(messages);
    const hasReasoning = hasOpenEndedReasoning(messages);

    // Normalize each dimension to 0-1
    const tokenScore = this.normalizeTokenCount(tokenCount);
    const toolScore = this.normalizeToolCount(toolCount);
    const turnsScore = this.normalizeTurns(turns);

    // Weighted combination
    const score = Math.min(1, Math.max(0,
      tokenScore * 0.25 +
      toolScore * 0.20 +
      turnsScore * 0.10 +
      (hasCode ? 0.35 : 0) +
      (hasReasoning ? 0.20 : 0) +
      (hasCode && hasReasoning ? 0.15 : 0) +
      (tokenCount > 2000 ? 0.10 : 0) +
      (turns >= 3 ? 0.10 : 0)
    ));

    // Determine effort level
    const thresholds = fusionConfig.complexity_scoring;
    let effort: EffortLevel;
    let reason: string;

    if (score <= thresholds.effort_1_threshold) {
      effort = 1;
      reason = `Low complexity (${score.toFixed(2)}) — using fast path`;
    } else if (score <= thresholds.effort_2_threshold) {
      effort = 2;
      reason = `Moderate complexity (${score.toFixed(2)}) — using parallel subagents`;
    } else {
      effort = 3;
      reason = `High complexity (${score.toFixed(2)}) — using full fusion pipeline`;
    }

    // Build a detailed reason string
    const details = [
      `tokens: ~${tokenCount} (score: ${tokenScore.toFixed(2)})`,
      `tools: ${toolCount} (score: ${toolScore.toFixed(2)})`,
      `turns: ${turns} (score: ${turnsScore.toFixed(2)})`,
      hasCode ? "code-gen: yes" : "code-gen: no",
      hasReasoning ? "reasoning: yes" : "reasoning: no",
    ];

    log.info("complexity score", {
      score: score.toFixed(3),
      effort,
      tokenCount,
      toolCount,
      turns,
      hasCode,
      hasReasoning,
    });

    return {
      score,
      effort,
      reason: `${reason} [${details.join(", ")}]`,
      tokenCount,
    };
  }

  private normalizeTokenCount(tokens: number): number {
    if (tokens <= 100) return 0;
    if (tokens >= 50_000) return 1;
    // S-curve: sigmoid-like progression
    const t = (tokens - 100) / (50_000 - 100);
    return Math.min(1, t * t * (3 - 2 * t)); // smoothstep
  }

  private normalizeToolCount(tools: number): number {
    if (tools === 0) return 0;
    if (tools >= 10) return 1;
    return Math.min(1, tools / 10);
  }

  private normalizeTurns(turns: number): number {
    if (turns <= 1) return 0;
    if (turns >= 20) return 1;
    return Math.min(1, (turns - 1) / 19);
  }
}
