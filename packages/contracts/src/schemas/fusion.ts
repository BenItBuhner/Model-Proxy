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

const DeprecatedEffort2ToolsSchema = z
  .array(z.enum(["context_search", "web_search"]))
  .optional()
  .transform((): Array<"context_search" | "web_search"> => []);

const DeprecatedEffort3ToolsSchema = z
  .array(z.enum(["context_search", "web_search", "code_execution"]))
  .optional()
  .transform((): Array<"context_search" | "web_search" | "code_execution"> => []);

export const Effort2ConfigSchema = z
  .object({
    subagent_count: z.object({
      min: z.number().int().min(1).default(2),
      max: z.number().int().min(1).default(4),
    }),
    /** Existing model routings to draw subagent models from (e.g. ["complete", "gemini"]). */
    model_routings: z.array(z.string().min(1)).min(1),
    /** Deprecated/no-op: accepted for legacy configs, normalized away. */
    tools: DeprecatedEffort2ToolsSchema,
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
    /** Deprecated/no-op: accepted for legacy configs, normalized away. */
    tools: DeprecatedEffort3ToolsSchema,
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

// ── Fusion Kernel (engine: "kernel") ───────────────────────────────────

/**
 * One model family in the kernel's pool. `routing` is an existing logical
 * model; `alt_routings` are same-family alternates used to widen parallel
 * sampling (e.g. `glm-5.3-alt`). Verifiers are always drawn from a different
 * family than the candidate they audit.
 */
export const FusionKernelFamilySchema = z
  .object({
    name: z.string().min(1),
    routing: z.string().min(1),
    alt_routings: z.array(z.string().min(1)).default([]),
    /** Relative share of extra sampling width when the wave is wider than the family count. */
    weight: z.number().positive().default(1),
    /** Exclude this family from proposing (verify/synthesize only). */
    propose: z.boolean().default(true),
    /** Exclude this family from verifying (propose only). */
    verify: z.boolean().default(true),
  })
  .strict();

export type FusionKernelFamily = z.infer<typeof FusionKernelFamilySchema>;

const EffortWidthSchema = z
  .object({
    F2: z.number().int().min(1).max(64),
    F3: z.number().int().min(1).max(64),
    max: z.number().int().min(1).max(128),
  })
  .strict();

export const FusionKernelConfigSchema = z
  .object({
    /** Model families that participate in proposal/verification waves. */
    families: z.array(FusionKernelFamilySchema).min(1),
    /** Final synthesis / executor routing. Defaults to `fusion.model_routing`. */
    synthesis_routing: z.string().min(1).optional(),
    /** Fast, cheap routing for intent extraction and light structured passes. Defaults to the summarizer routing. */
    fast_routing: z.string().min(1).optional(),
    /** `reasoning_effort` forwarded to the synthesis/executor model (unset = model default, i.e. deepest). */
    synthesis_reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
    /** Target input tokens per worker context capsule (hard cap for proposers/verifiers). */
    capsule_tokens: z.number().int().min(2_000).max(200_000).default(24_000),
    /** Max output tokens for proposal/verification workers (ceiling; see worker_max_tokens_by_band). */
    worker_max_tokens: z.number().int().min(256).max(65_536).default(6_000),
    /** Optional per-band proposal output budgets; each is capped by worker_max_tokens. */
    worker_max_tokens_by_band: z
      .object({ F2: z.number().int().min(256), F3: z.number().int().min(256), max: z.number().int().min(256) })
      .strict()
      .optional(),
    /** Max output tokens for verifiers (they are terse by contract). */
    verifier_max_tokens: z.number().int().min(256).max(32_768).default(2_500),
    /** Start verifying each candidate as soon as it lands instead of after the whole proposal wave settles. */
    pipeline_verification: z.boolean().default(true),
    /**
     * Vote-adaptive verification: when proposals declare final answers and the
     * vote is unanimous across ≥2 families, verify only the leading candidate;
     * when the vote is split, verify every candidate. Off = verify all.
     */
    adaptive_verification: z.boolean().default(true),
    /**
     * `reasoning_effort` forwarded to upstream thinking models per worker role
     * (omitted roles use the model default). Verifiers and intent extraction
     * are terse by contract, so lower effort there cuts latency without
     * touching proposal depth.
     */
    worker_reasoning_effort: z
      .object({
        proposer: z.enum(["low", "medium", "high"]).optional(),
        verifier: z.enum(["low", "medium", "high"]).optional(),
        intent: z.enum(["low", "medium", "high"]).optional(),
        repair: z.enum(["low", "medium", "high"]).optional(),
        checkpoint: z.enum(["low", "medium", "high"]).optional(),
      })
      .strict()
      .default({}),
    /** Per-worker hard wall clock cap (also bounded by the band's search deadline). */
    worker_timeout_seconds: z.number().int().positive().default(300),
    /** Abort a worker whose upstream stream has produced no bytes (content or reasoning) for this long. */
    worker_idle_timeout_seconds: z.number().int().positive().default(60),
    /** Parallel proposals per wave, by effort band. */
    proposal_width: EffortWidthSchema.default({ F2: 3, F3: 6, max: 9 }),
    /** Cross-family verifiers per surviving candidate, by effort band. */
    verifiers_per_candidate: EffortWidthSchema.default({ F2: 1, F3: 2, max: 3 }),
    /** Maximum proposal waves (escalations) before synthesis, by effort band. */
    max_waves: EffortWidthSchema.default({ F2: 2, F3: 3, max: 4 }),
    /** Agreement score (0-1) at or above which the search stops escalating. */
    agreement_threshold: z.number().min(0).max(1).default(0.62),
    /** Max concurrent upstream worker calls across all waves. */
    max_concurrency: z.number().int().min(1).max(128).default(12),
    /**
     * Fraction of a wave's workers that must finish (across ≥2 families when
     * available) before stragglers are put on the grace clock. 1 = wait for all.
     */
    wave_quorum: z.number().min(0.34).max(1).default(0.67),
    /** After quorum, stragglers get this long before they are cancelled (partial output ≥ 800 chars is kept). */
    straggler_grace_seconds: z.number().int().min(0).max(600).default(25),
    /** Total proposal+verification budget per effort band; when exceeded the search settles with what it has. */
    search_deadline_seconds: z
      .object({ F2: z.number().int().positive(), F3: z.number().int().positive(), max: z.number().int().positive() })
      .strict()
      .default({ F2: 300, F3: 600, max: 1800 }),
    /** Run a fast LLM intent parse for F2+ fresh tasks (cached by work key). */
    intent_extraction: z.boolean().default(true),
    /** Tool-continuation policy. */
    continuation: z
      .object({
        /** Reuse the plan for tool-continuation turns instead of re-searching. */
        enabled: z.boolean().default(true),
        /** Force a bounded replan after this many continuation steps. */
        max_steps_before_replan: z.number().int().min(1).max(200).default(14),
        /** Run a bounded repair wave when a tool result carries an error signal. */
        repair_on_error: z.boolean().default(true),
        /** Identical failure signatures get at most this many repair waves. */
        max_repairs_per_signature: z.number().int().min(0).max(5).default(1),
      })
      .strict()
      .default({}),
    /** Bump to invalidate every cached work item produced under older prompts/policies. */
    policy_version: z.number().int().min(1).default(1),
  })
  .strict();

export type FusionKernelConfig = z.infer<typeof FusionKernelConfigSchema>;

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

    /**
     * Orchestration engine. `legacy` is the divider → sealed subagents →
     * synthesis pipeline. `kernel` is the epistemic kernel: durable per-
     * conversation ledger, tool-continuation without re-decomposition,
     * content-addressed work cache, bounded capsules, and cross-family
     * proposal/verification waves. `kernel` requires the `kernel` block.
     */
    engine: z.enum(["legacy", "kernel"]).default("legacy"),
    kernel: FusionKernelConfigSchema.optional(),
  })
  .strict()
  .refine(
    (val) => val.engine !== "kernel" || val.kernel !== undefined,
    { message: "fusion.kernel is required when fusion.engine is \"kernel\"", path: ["kernel"] },
  );

export type FusionConfig = z.infer<typeof FusionConfigSchema>;
