import { z } from "zod";

export const HEDGED_ROUTING_DEFAULTS = {
  enabled: false,
  min_parallel: 2,
  max_parallel: 8,
  max_parallel_jitter: 0,
  stagger_ms: 250,
  stagger_jitter_ms: 0,
  primary_bias: 0.65,
  include_fallback_model_routings: true,
  winner_policy: "first_meaningful_event" as const,
  stream_min_content_chars: 1,
  cancel_losers: true,
};

export const HedgedRoutingConfigSchema = z
  .object({
    enabled: z.boolean().default(HEDGED_ROUTING_DEFAULTS.enabled),
    min_parallel: z.number().int().min(1).max(30).default(HEDGED_ROUTING_DEFAULTS.min_parallel),
    max_parallel: z.number().int().min(1).max(30).default(HEDGED_ROUTING_DEFAULTS.max_parallel),
    max_parallel_jitter: z.number().int().min(0).max(20).default(HEDGED_ROUTING_DEFAULTS.max_parallel_jitter),
    stagger_ms: z.number().int().min(0).max(30_000).default(HEDGED_ROUTING_DEFAULTS.stagger_ms),
    stagger_jitter_ms: z.number().int().min(0).max(30_000).default(HEDGED_ROUTING_DEFAULTS.stagger_jitter_ms),
    primary_bias: z.number().min(0).max(1).default(HEDGED_ROUTING_DEFAULTS.primary_bias),
    include_fallback_model_routings: z.boolean().default(HEDGED_ROUTING_DEFAULTS.include_fallback_model_routings),
    winner_policy: z.literal("first_meaningful_event").default(HEDGED_ROUTING_DEFAULTS.winner_policy),
    stream_min_content_chars: z.number().int().min(0).max(10_000).default(HEDGED_ROUTING_DEFAULTS.stream_min_content_chars),
    cancel_losers: z.boolean().default(HEDGED_ROUTING_DEFAULTS.cancel_losers),
  })
  .strict()
  .refine((value) => value.min_parallel <= value.max_parallel, {
    message: "min_parallel must be less than or equal to max_parallel",
    path: ["min_parallel"],
  });

export type HedgedRoutingConfig = z.infer<typeof HedgedRoutingConfigSchema>;
