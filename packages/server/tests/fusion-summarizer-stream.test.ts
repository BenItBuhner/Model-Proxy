import { describe, it, expect } from "bun:test";
import {
  SmoothStreamer,
  SummaryPump,
  ThinkTagFilter,
  paceReasoningText,
  stripToolCallArtifacts,
  type ReasoningSummarizer,
  type SummarySegment,
} from "../src/routing/fusion/reasoning-summarizer.ts";
import type { FusionRequestContext } from "../src/routing/fusion/types.ts";
import type { FusionConfig } from "@model-proxy/contracts/schemas/fusion.ts";

const testFusionConfig: FusionConfig = {
  enabled: true,
  context_window: 10_000_000,
  complexity_scoring: { effort_1_threshold: 0.2, effort_2_threshold: 0.55 },
  task_divider: { model_routing: "glm-5.2", timeout_seconds: 120, max_subtasks: 10 },
  effort_levels: {
    1: { model_routing: "glm-5.2" },
    2: { subagent_count: { min: 2, max: 3 }, model_routings: ["glm-5.2"], tools: ["context_search"] },
    3: { subagent_count: { min: 3, max: 5 }, model_routings: ["glm-5.2"], tools: ["context_search"] },
  },
  fusion: { model_routing: "glm-5.2", strategy: "sequential_append", wire_protocol: "openai" },
  cache: { enabled: false, scope: "permanent" },
  summarizer: { enabled: true, model_routing: "turbo", segment_chars: 1400, max_summary_tokens: 256 },
  scheduler: { allow_nested_fusion: false, max_depth: 0, max_leaf_calls: 8, max_wall_ms: 120_000 },
  engine: "legacy",
};

function makeCtx(): FusionRequestContext {
  return {
    logicalModel: "fusion-beta",
    fusionConfig: testFusionConfig,
    requestData: {},
    clientProtocol: "openai",
    messages: [],
  };
}

function extractReasoningText(sseChunk: string): string {
  const dataLine = sseChunk.split("\n").find((l) => l.startsWith("data:"));
  if (dataLine === undefined) return "";
  const parsed = JSON.parse(dataLine.replace(/^data:\s?/, "")) as {
    choices?: Array<{ delta?: { reasoning_content?: string } }>;
  };
  return parsed.choices?.[0]?.delta?.reasoning_content ?? "";
}

// ── stripToolCallArtifacts ────────────────────────────────────────────

describe("stripToolCallArtifacts", () => {
  it("removes XML-style tool call blocks", () => {
    const text = 'Before analysis. <tool_call>{"name": "write_file", "arguments": {"path": "x"}}</tool_call> After analysis.';
    const out = stripToolCallArtifacts(text);
    expect(out).not.toContain("write_file");
    expect(out).toContain("Before analysis.");
    expect(out).toContain("After analysis.");
  });

  it("removes unterminated tool call blocks at end of text", () => {
    const text = 'Findings so far. <tool_call>{"name": "bash", "arguments"';
    const out = stripToolCallArtifacts(text);
    expect(out).not.toContain("bash");
    expect(out).toContain("Findings so far.");
  });

  it("removes bare tool-invocation JSON blobs", () => {
    const text = 'The fix: {"name": "edit_file", "arguments": {"target": "src/app.ts"}} then re-run tests.';
    const out = stripToolCallArtifacts(text);
    expect(out).not.toContain("edit_file");
    expect(out).toContain("then re-run tests.");
  });

  it("removes fenced tool-call JSON code blocks", () => {
    const text = 'I will call the tool:\n```json\n{"tool_calls": [{"function": {"name": "run_shell"}}]}\n```\nDone reasoning.';
    const out = stripToolCallArtifacts(text);
    expect(out).not.toContain("run_shell");
    expect(out).toContain("Done reasoning.");
  });

  it("preserves ordinary prose and code recommendations", () => {
    const text = "Recommend changing `parseOpenAIDelta` to return tool deltas.\n\nSecond paragraph stays.";
    expect(stripToolCallArtifacts(text)).toBe(text);
  });
});

// ── ThinkTagFilter ────────────────────────────────────────────────────

describe("ThinkTagFilter", () => {
  it("removes think spans within a single token", () => {
    const filter = new ThinkTagFilter();
    const out = filter.write("<think>hidden</think>Visible text here.") + filter.flush();
    expect(out).toBe("Visible text here.");
  });

  it("removes think spans split across tokens", () => {
    const filter = new ThinkTagFilter();
    let out = "";
    for (const token of ["<thi", "nk>secret ", "stuff</th", "ink>Clean", " output."]) {
      out += filter.write(token);
    }
    out += filter.flush();
    expect(out).toBe("Clean output.");
  });

  it("passes through text with no tags", () => {
    const filter = new ThinkTagFilter();
    let out = "";
    for (const token of ["Examining the ", "auth middleware; ", "found the issue."]) {
      out += filter.write(token);
    }
    out += filter.flush();
    expect(out).toBe("Examining the auth middleware; found the issue.");
  });

  it("drops unterminated think spans", () => {
    const filter = new ThinkTagFilter();
    const out = filter.write("Good part. <think>never closed rambling") + filter.flush();
    expect(out).toBe("Good part. ");
  });
});

// ── SmoothStreamer ────────────────────────────────────────────────────

describe("SmoothStreamer", () => {
  it("splits a large blob into multiple small word-bounded pieces", async () => {
    const smoother = new SmoothStreamer();
    const blob = "This is a long paragraph of summary text that would otherwise appear instantly as one giant chunk in the client reasoning panel.";
    const pieces: string[] = [];
    for await (const piece of smoother.write(blob)) pieces.push(piece);
    for await (const piece of smoother.drain()) pieces.push(piece);

    expect(pieces.length).toBeGreaterThan(3);
    expect(pieces.join("")).toBe(blob);
    for (const piece of pieces.slice(0, -1)) {
      expect(piece.length).toBeLessThanOrEqual(56);
    }
  });

  it("holds tiny fragments until enough text accumulates", async () => {
    const smoother = new SmoothStreamer();
    const pieces: string[] = [];
    for await (const piece of smoother.write("tiny")) pieces.push(piece);
    expect(pieces.length).toBe(0);
    for await (const piece of smoother.drain()) pieces.push(piece);
    expect(pieces.join("")).toBe("tiny");
  });
});

// ── paceReasoningText ─────────────────────────────────────────────────

describe("paceReasoningText", () => {
  it("emits multiple reasoning_content SSE chunks that reassemble the text", async () => {
    const ctx = makeCtx();
    const text = "Recalling three cached deep-reasoning results and skipping duplicate subagent execution for this conversation turn.\n\n";
    const chunks: string[] = [];
    for await (const chunk of paceReasoningText(ctx, text)) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = chunks.map(extractReasoningText).join("");
    expect(reassembled).toBe(text);
  });
});

// ── SummaryPump ───────────────────────────────────────────────────────

function makeFakeSummarizer(summaryByLabel: (segment: SummarySegment) => string): ReasoningSummarizer {
  return {
    isEnabled: () => true,
    configFor: () => testFusionConfig.summarizer,
    // eslint-disable-next-line @typescript-eslint/require-await
    summarize: async function* (_ctx: unknown, segment: SummarySegment) {
      yield summaryByLabel(segment);
    },
  } as unknown as ReasoningSummarizer;
}

describe("SummaryPump", () => {
  it("streams summaries without any label prefix and separates paragraphs", async () => {
    const summarizer = makeFakeSummarizer(() => "Investigating the fallback router; the hedge ignores reasoning-only chunks.");
    const observed: Array<{ label: string; text: string }> = [];
    const pump = new SummaryPump(summarizer, makeCtx(), {
      onSummary: (label, text) => observed.push({ label, text }),
    });

    pump.enqueue({ label: "research-1 · research", text: "raw transcript segment ".repeat(20) });
    pump.finish();

    let out = "";
    for await (const chunk of pump.chunks()) {
      out += extractReasoningText(chunk);
    }

    expect(out).not.toContain("[research-1");
    expect(out).not.toContain("]");
    expect(out).toContain("Investigating the fallback router");
    expect(out.endsWith("\n\n")).toBe(true);
    // Label still flows to observability
    expect(observed.length).toBe(1);
    expect(observed[0].label).toBe("research-1 · research");
  });

  it("coalesces backlogged segments from the same producer", async () => {
    const seen: string[] = [];
    const summarizer = makeFakeSummarizer((segment) => {
      seen.push(segment.text);
      return "Summarized segment content for testing purposes right here.";
    });
    const pump = new SummaryPump(summarizer, makeCtx());

    pump.enqueue({ label: "a", text: "first part. " });
    pump.enqueue({ label: "a", text: "second part. " });
    pump.enqueue({ label: "b", text: "other producer. " });
    pump.finish();

    let total = "";
    for await (const chunk of pump.chunks()) {
      total += extractReasoningText(chunk);
    }

    expect(total.length).toBeGreaterThan(0);
    // First two same-label segments merged into one summarizer call
    expect(seen.length).toBe(2);
    expect(seen[0]).toContain("first part.");
    expect(seen[0]).toContain("second part.");
    expect(seen[1]).toContain("other producer.");
  });
});
