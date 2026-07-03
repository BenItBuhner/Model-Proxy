import { z } from "zod";

/**
 * Schema for the Model Fusion (Beta) feature.
 * This is embedded as an optional `fusion` field inside ModelRoutingConfig.
 * When present, the request is dispatched to the FusionRouter instead of
 * the standard FallbackRouter.
 */

// ── Effort-level sub-configs ──────────────────────────────────────────

export const Effort1ConfigSchema = z
  .object({
    /** Single existing model routing to use for fast-path (e.g. "turbo"). */
    model_routing: z.string().min(1),
  })
  .strict();

export type Effort1Config = z.infer<typeof Effort1ConfigSchema>;

export const Effort2ConfigSchema = z
  .object({
    subagent_count: z.object({
      min: z.number().int().min(1).default(2),
      max: z.number().int().min(1).default(4),
    }),
    /** Existing model routings to draw subagent models from (e.g. ["complete", "gemini"]). */
    model_routings: z.array(z.string().min(1)).min(1),
    tools: z
      .array(z.enum(["context_search", "web_search"]))
      .default(["context_search"]),
  })
  .strict()
  .refine(
    (val) => val.subagent_count.min <= val.subagent_count.max,
    { message: "subagent_count.min must be <= subagent_count.max", path: ["subagent_count"] },
  );

export type Effort2Config = z.infer<typeof Effort2ConfigSchema>;

export const Effort3ConfigSchema = z
  .object({
    subagent_count: z.object({
      min: z.number().int().min(1).default(4),
      max: z.number().int().min(1).default(8),
    }),
    /** Existing model routings to draw subagent models from. */
    model_routings: z.array(z.string().min(1)).min(1),
    tools: z
      .array(z.enum(["context_search", "web_search", "code_execution"]))
      .default(["context_search", "web_search", "code_execution"]),
  })
  .strict()
  .refine(
    (val) => val.subagent_count.min <= val.subagent_count.max,
    { message: "subagent_count.min must be <= subagent_count.max", path: ["subagent_count"] },
  );

export type Effort3Config = z.infer<typeof Effort3ConfigSchema>;

// ── Complexity Scoring ────────────────────────────────────────────────

export const ComplexityScoringConfigSchema = z
  .object({
    /** Below this score (0-1) → Effort 1 (fast path). */
    effort_1_threshold: z.number().min(0).max(1).default(0.15),
    /** Above this score (0-1) → Effort 3 (full fusion). Between → Effort 2. */
    effort_2_threshold: z.number().min(0).max(1).default(0.45),
  })
  .strict()
  .refine(
    (val) => val.effort_1_threshold <= val.effort_2_threshold,
    { message: "effort_1_threshold must be <= effort_2_threshold", path: ["effort_1_threshold"] },
  );

export type ComplexityScoringConfig = z.infer<typeof ComplexityScoringConfigSchema>;

// ── Task Divider ──────────────────────────────────────────────────────

export const TaskDividerConfigSchema = z
  .object({
    /** Existing model routing that powers the task division agent. */
    model_routing: z.string().default("glm-5.2"),
    timeout_seconds: z.number().int().positive().default(60),
    /** Maximum sub-tasks the divider can produce. */
    max_subtasks: z.number().int().min(1).max(50).default(10),
  })
  .strict();

export type TaskDividerConfig = z.infer<typeof TaskDividerConfigSchema>;

// ── Fusion Synthesis (Layer 5) ────────────────────────────────────────

export const FusionSynthesisConfigSchema = z
  .object({
    /** Existing model routing that consumes subagent outputs and produces the final response. */
    model_routing: z.string().min(1),
    strategy: z.literal("sequential_append").default("sequential_append"),
    /** Wire protocol for the final output. */
    wire_protocol: z.enum(["openai", "anthropic"]).default("openai"),
  })
  .strict();

export type FusionSynthesisConfig = z.infer<typeof FusionSynthesisConfigSchema>;

// ── Reasoning Summarizer ─────────────────────────────────────────────

export const FusionSummarizerConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Fast/cheap existing model routing that live-summarizes raw reasoning (e.g. "turbo"). */
    model_routing: z.string().min(1).default("turbo"),
    /** Raw reasoning/transcript characters accumulated before a summary segment is produced. */
    segment_chars: z.number().int().min(200).max(20000).default(1400),
    /** Max output tokens per summary segment. */
    max_summary_tokens: z.number().int().min(32).max(4096).default(256),
  })
  .strict();

export type FusionSummarizerConfig = z.infer<typeof FusionSummarizerConfigSchema>;

// ── Cache ─────────────────────────────────────────────────────────────

export const FusionCacheConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    scope: z.literal("permanent").default("permanent"),
  })
  .strict();

export type FusionCacheConfig = z.infer<typeof FusionCacheConfigSchema>;

// ── Bounded scheduler / nested Fusion controls ─────────────────────────

export const FusionSchedulerConfigSchema = z
  .object({
    allow_nested_fusion: z.boolean().default(false),
    max_depth: z.number().int().min(0).max(8).default(0),
    max_leaf_calls: z.number().int().min(1).max(64).default(8),
    max_wall_ms: z.number().int().positive().default(120_000),
  })
  .strict();

export type FusionSchedulerConfig = z.infer<typeof FusionSchedulerConfigSchema>;

// ── Top-level Fusion Config ───────────────────────────────────────────

export const FusionConfigSchema = z
  .object({
    enabled: z.boolean(),

    /** Claimed context window for the fusion model (default 10M tokens). */
    context_window: z.number().int().positive().default(10_000_000),

    // Layer 2: Complexity scoring
    complexity_scoring: ComplexityScoringConfigSchema.default({}),

    // Layer 3: Task divider
    task_divider: TaskDividerConfigSchema.default({}),

    // Layer 4: Effort-level subagent configurations
    effort_levels: z.object({
      1: Effort1ConfigSchema,
      2: Effort2ConfigSchema.optional(),
      3: Effort3ConfigSchema.optional(),
    }),

    // Layer 5: Fusion synthesis
    fusion: FusionSynthesisConfigSchema,

    // Live reasoning summarizer (streams summaries of subagent + synthesis reasoning)
    summarizer: FusionSummarizerConfigSchema.default({}),

    // Layer 1: Cache
    cache: FusionCacheConfigSchema.default({}),

    // Bounded scheduler controls for optional nested Fusion.
    scheduler: FusionSchedulerConfigSchema.default({}),
  })
  .strict();

export type FusionConfig = z.infer<typeof FusionConfigSchema>;
