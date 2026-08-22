import { z } from "zod";

/**
 * Per-model / per-request configuration for the tool-call + response
 * validation abstraction ("enforce mode").
 *
 * Precedence (highest first):
 *   1. X-Enforce-Tool-Call request header
 *   2. ?enforce_tool_call= query param
 *   3. ModelRoutingConfig.enforce_tool_call (per logical model)
 *   4. Environment variable defaults (ENFORCE_TOOL_CALL_MODE, etc.)
 */
export const EnforceToolCallConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    termination_flag: z.string().min(1).optional(),
    max_retries: z.number().int().min(1).max(50).optional(),
    guidance: z.string().optional(),
    stream_chunk_delay_ms: z.number().min(0).max(10_000).optional(),
    /**
     * How aggressively to treat whitespace/empty content as invalid.
     *   "strict" (default) — empty/whitespace content with no tool_calls is rejected.
     *   "lenient" — empty content is accepted only if finish_reason === "stop".
     */
    empty_response_policy: z.enum(["strict", "lenient"]).optional(),
  })
  .strict();

export type EnforceToolCallConfig = z.infer<typeof EnforceToolCallConfigSchema>;

/**
 * Fully resolved enforce config (no optionals) — produced after merging
 * request-level, model-level, and env-level values.
 */
export interface ResolvedEnforceConfig {
  enabled: boolean;
  terminationFlag: string;
  maxRetries: number;
  guidance: string;
  streamChunkDelayMs: number;
  emptyResponsePolicy: "strict" | "lenient";
}

export const DEFAULT_TERMINATION_FLAG = '{"tool_loop":"completed"}';

export const DEFAULT_GUIDANCE =
  '\n\nIMPORTANT: When you are finished with all tool calls, ' +
  "respond with ONLY this JSON object and nothing else: " +
  '{"tool_loop": "completed"}';
