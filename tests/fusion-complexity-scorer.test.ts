import { describe, it, expect } from "bun:test";
import { ComplexityScorer } from "../src/routing/fusion/complexity-scorer.ts";
import type { FusionRequestContext } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "../shared/schemas/fusion.ts";

const defaultFusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: {
    effort_1_threshold: 0.15,
    effort_2_threshold: 0.45,
  },
  task_divider: {
    model_routing: "glm-5.2",
    timeout_seconds: 60,
    max_subtasks: 10,
  },
  effort_levels: {
    1: { model_routing: "turbo" },
    2: {
      subagent_count: { min: 2, max: 4 },
      model_routings: ["complete"],
      tools: ["context_search"],
    },
    3: {
      subagent_count: { min: 4, max: 8 },
      model_routings: ["complete", "glm-5.2"],
      tools: ["context_search", "code_execution"],
    },
  },
  fusion: {
    model_routing: "glm-5.2",
    strategy: "sequential_append",
    wire_protocol: "openai",
  },
  cache: { enabled: true, scope: "permanent" },
};

function makeCtx(messages: unknown[]): FusionRequestContext {
  return {
    logicalModel: "fusion-beta",
    fusionConfig: defaultFusionConfig,
    requestData: { messages },
    clientProtocol: "openai",
    messages,
  };
}

describe("ComplexityScorer", () => {
  const scorer = new ComplexityScorer();

  it("returns effort 1 for simple queries", () => {
    const ctx = makeCtx([
      { role: "user", content: "What is 2+2?" },
    ]);
    const result = scorer.score(ctx);
    expect(result.effort).toBe(1);
    expect(result.score).toBeLessThanOrEqual(0.3);
  });

  it("returns effort 2 for moderately complex tasks", () => {
    const ctx = makeCtx([
      { role: "user", content: "Write a function that sorts an array" },
      { role: "assistant", content: "Here's a sorting implementation" },
      { role: "user", content: "Now add error handling and make it generic" },
    ]);
    const result = scorer.score(ctx);
    expect(result.effort).toBeGreaterThanOrEqual(1);
    expect(result.tokenCount).toBeGreaterThan(0);
  });

  it("returns effort 3 for complex multi-turn code tasks", () => {
    // Build a prompt that triggers code + reasoning + high token count
    const codeTask = `
      Implement a full-stack calendar application with Next.js and Supabase.
      Design the database schema for events, users, and sharing.
      Implement the API endpoints for CRUD operations.
      Add authentication and authorization.
      Write tests for all components.
      Optimize the query performance with caching.
      Handle error cases and edge conditions.
    `.repeat(100);
    const ctx = makeCtx([
      {
        role: "system",
        content: "You are an expert software engineer. Implement, design, architect, and optimize.",
      },
      { role: "user", content: "Build a complete application with authentication, database, API, and testing" },
      { role: "assistant", content: "Let me design and plan this architecture carefully." },
      { role: "user", content: codeTask },
    ]);
    const result = scorer.score(ctx);
    expect(result.effort).toBe(3);
    expect(result.tokenCount).toBeGreaterThan(500);
  });

  it("scores highly with many tools", () => {
    const ctx: FusionRequestContext = {
      logicalModel: "fusion-beta",
      fusionConfig: defaultFusionConfig,
      requestData: {
        messages: [
          { role: "user", content: "Analyze this data using available tools" },
        ],
        // Tools at the request level (OpenAI API format)
        tools: Array.from({ length: 8 }, (_, i) => ({
          type: "function",
          function: {
            name: `tool_${i}`,
            description: `Tool ${i}`,
            parameters: { type: "object", properties: {} },
          },
        })),
      },
      clientProtocol: "openai",
      messages: [
        { role: "user", content: "Analyze this data using available tools" },
      ],
    };
    const result = scorer.score(ctx);
    expect(result.effort).toBeGreaterThanOrEqual(2);
  });

  it("handles Anthropic-format tool calls", () => {
    const ctx = makeCtx([
      {
        role: "user",
        content: "Research and compare solutions",
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me analyze this" },
          { type: "tool_use", name: "search", input: { query: "test" } },
          { type: "tool_result", content: "Results here" },
        ],
      },
    ]);
    const result = scorer.score(ctx);
    expect(result.effort).toBeGreaterThanOrEqual(1);
    expect(result.score).toBeGreaterThan(0);
  });

  it("never returns NaN or negative scores", () => {
    const ctx = makeCtx([
      { role: "user", content: "Hi" },
    ]);
    const result = scorer.score(ctx);
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });
});
