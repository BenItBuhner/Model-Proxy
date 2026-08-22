import { createLogger } from "../../observability/logger.ts";
import type { FusionRequestContext, ComplexityScore, EffortLevel } from "./types.ts";

const log = createLogger("routing.fusion.complexity");

/**
 * Token estimation: chars / 4, mirroring standard heuristic.
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

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
    } else {
      // Count the whole message JSON for tool_calls, images, etc.
      total += estimateTokenCount(JSON.stringify(msg));
    }
  }
  return total;
}

function countTools(messages: unknown[], requestData?: Record<string, unknown>): number {
  let count = 0;
  if (requestData && Array.isArray(requestData["tools"])) {
    count += (requestData["tools"] as unknown[]).length;
  }
  for (const msg of messages) {
    const m = msg as Record<string, unknown>;
    if (m["tools"] && Array.isArray(m["tools"])) {
      count += m["tools"].length;
    }
    if (Array.isArray(m["content"])) {
      for (const part of m["content"]) {
        const p = part as Record<string, unknown>;
        if (p["type"] === "tool_use" || p["type"] === "tool_result") {
          count += 1;
        }
      }
    }
    if (m["tool_calls"] && Array.isArray(m["tool_calls"])) {
      count += m["tool_calls"].length;
    }
    if (m["function_call"] !== undefined) {
      count += 1;
    }
  }
  return count;
}

function countConversationTurns(messages: unknown[]): number {
  let turns = 0;
  let lastRole = "";
  for (const msg of messages) {
    const role = (msg as Record<string, unknown>)["role"] as string | undefined;
    if (role === "user" && lastRole === "assistant") {
      turns += 1;
    }
    lastRole = role ?? "";
  }
  return Math.max(1, turns);
}

function hasCodeGeneration(messages: unknown[]): boolean {
  const codeKeywords = [
    "implement", "function", "class ", "def ", "const ", "let ", "import ",
    "require(", "component", "api", "endpoint", "database", "schema",
    "algorithm", "optimize", "refactor", "bug", "error", "typescript",
    "javascript", "scheduler", "queue", "migration", "adapter", "test",
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

function hasOpenEndedReasoning(messages: unknown[]): boolean {
  const reasoningKeywords = [
    "explain", "analyze", "compare", "contrast", "research", "investigate",
    "why", "how does", "what is the best", "evaluate", "assess",
    "design", "architect", "plan", "strategy", "prove", "proof",
    "invariant", "correctness", "complexity analysis", "counterexample",
    "starvation", "bounded wait", "ranking function",
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

function hasImageContent(messages: unknown[]): boolean {
  for (const msg of messages) {
    const content = (msg as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const p = part as Record<string, unknown>;
      if (p["type"] === "image_url") {
        return true;
      }
    }
  }
  return false;
}

/**
 * ComplexityScorer (Layer 2)
 *
 * Analyzes the incoming request and assigns a complexity score (0-1)
 * which determines the effort level for fusion routing.
 *
 * Scoring dimensions (scaled for 1M token contexts):
 *  - Token count (weight: high) — scales from 0 at 100 tokens to 1 at 500K tokens
 *  - Tool count (weight: medium)
 *  - Conversation turns (weight: medium)
 *  - Code generation presence (weight: medium)
 *  - Open-ended reasoning presence (weight: low)
 *  - Image content presence (weight: medium)
 */
export class ComplexityScorer {
  score(ctx: FusionRequestContext): ComplexityScore {
    const { messages, fusionConfig, requestData } = ctx;
    const tokenCount = estimateTotalTokens(messages);
    const toolCount = countTools(messages, requestData);
    const turns = countConversationTurns(messages);
    const hasCode = hasCodeGeneration(messages);
    const hasReasoning = hasOpenEndedReasoning(messages);
    const hasImages = !!ctx.hadImages || hasImageContent(messages);

    const tokenScore = this.normalizeTokenCount(tokenCount);
    const toolScore = this.normalizeToolCount(toolCount);
    const turnsScore = this.normalizeTurns(turns);

    // Weighted combination — scales for 1M token contexts
    const score = Math.min(1, Math.max(0,
      tokenScore * 0.30 +
      toolScore * 0.20 +
      turnsScore * 0.10 +
      (hasCode ? 0.25 : 0) +
      (hasReasoning ? 0.15 : 0) +
      (hasCode && hasReasoning ? 0.10 : 0) +
      (hasImages ? 0.20 : 0) +
      (tokenCount > 2000 ? 0.10 : 0) +
      (turns >= 5 ? 0.10 : 0)
    ));

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

    const details = [
      `tokens: ~${tokenCount} (score: ${tokenScore.toFixed(2)})`,
      `tools: ${toolCount} (score: ${toolScore.toFixed(2)})`,
      `turns: ${turns} (score: ${turnsScore.toFixed(2)})`,
      hasCode ? "code-gen: yes" : "code-gen: no",
      hasReasoning ? "reasoning: yes" : "reasoning: no",
      hasImages ? "images: yes" : "images: no",
    ];

    log.info("complexity score", {
      score: score.toFixed(3),
      effort,
      tokenCount,
      toolCount,
      turns,
      hasCode,
      hasReasoning,
      hasImages,
    });

    return {
      score,
      effort,
      reason: `${reason} [${details.join(", ")}]`,
      tokenCount,
    };
  }

  /**
   * Normalize token count on a scale that goes to 500K tokens
   * (suitable for 1M context-window models).
   *  - < 100 tokens: 0
   *  - >= 500K tokens: 1
   *  - Smooth sigmoid-like progression between.
   */
  private normalizeTokenCount(tokens: number): number {
    if (tokens <= 100) return 0;
    if (tokens >= 500_000) return 1;
    const t = (tokens - 100) / (500_000 - 100);
    return Math.min(1, t * t * (3 - 2 * t)); // smoothstep
  }

  private normalizeToolCount(tools: number): number {
    if (tools === 0) return 0;
    if (tools >= 10) return 1;
    return Math.min(1, tools / 10);
  }

  private normalizeTurns(turns: number): number {
    if (turns <= 1) return 0;
    if (turns >= 30) return 1;
    return Math.min(1, (turns - 1) / 29);
  }
}
