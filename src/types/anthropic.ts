/**
 * Anthropic Messages API type definitions (Zod schemas).
 */
import { z } from "zod";

// ── Content Blocks ────────────────────────────────────────────────
export const ContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.record(z.any()).optional(),
  tool_use_id: z.string().optional(),
  content: z.any().optional(),
  is_error: z.boolean().optional(),
});

export const MessageContentSchema = z.union([
  z.string(),
  z.array(ContentBlockSchema),
]);

// ── Messages ──────────────────────────────────────────────────────
export const AnthropicMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: MessageContentSchema,
  metadata: z.record(z.any()).optional(),
});

// ── Tools ─────────────────────────────────────────────────────────
export const AnthropicToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  input_schema: z.record(z.any()),
});

export const AnthropicToolChoiceSchema = z.union([
  z.string(),
  z.object({
    type: z.string(),
    name: z.string().optional(),
  }),
]);

// ── Request ───────────────────────────────────────────────────────
export const AnthropicMessagesRequestSchema = z.object({
  model: z.string(),
  messages: z.array(AnthropicMessageSchema),
  max_tokens: z.number().int().positive().default(16000),
  system: z.union([z.string(), z.array(ContentBlockSchema)]).optional(),
  stop_sequences: z.array(z.string()).optional(),
  metadata: z.record(z.any()).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(0).optional(),
  stream: z.boolean().optional().default(false),
  tools: z.array(AnthropicToolSchema).optional(),
  tool_choice: AnthropicToolChoiceSchema.optional(),
  betas: z.array(z.string()).optional(),
  thinking: z.record(z.any()).optional(),
});

// ── Response ──────────────────────────────────────────────────────
export const AnthropicUsageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().default(0),
});

export const AnthropicMessagesResponseSchema = z.object({
  id: z.string(),
  type: z.enum(["message", "error"]).default("message"),
  role: z.enum(["assistant", "user"]).default("assistant"),
  model: z.string(),
  content: z.array(ContentBlockSchema),
  stop_reason: z.string().nullable().optional(),
  stop_sequence: z.string().nullable().optional(),
  usage: AnthropicUsageSchema,
});

// ── Inferred Types ────────────────────────────────────────────────
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type AnthropicMessage = z.infer<typeof AnthropicMessageSchema>;
export type AnthropicTool = z.infer<typeof AnthropicToolSchema>;
export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequestSchema>;
export type AnthropicMessagesResponse = z.infer<typeof AnthropicMessagesResponseSchema>;
export type AnthropicUsage = z.infer<typeof AnthropicUsageSchema>;
