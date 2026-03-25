/**
 * OpenAI Chat Completions API type definitions (Zod schemas).
 */
import { z } from "zod";

// ── Tool Definitions ──────────────────────────────────────────────
export const FunctionDefinitionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.any()).optional(),
});

export const ToolDefinitionSchema = z.object({
  type: z.literal("function").default("function"),
  function: FunctionDefinitionSchema,
});

export const ToolFunctionCallSchema = z.object({
  name: z.string(),
  arguments: z.string(),
});

export const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function").default("function"),
  function: ToolFunctionCallSchema,
});

// ── Messages ──────────────────────────────────────────────────────
export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool", "function"]),
  content: z.union([z.string(), z.array(z.record(z.any())), z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

export const StreamOptionsSchema = z.object({
  include_usage: z.boolean().optional(),
});

// ── Request ───────────────────────────────────────────────────────
export const ChatCompletionRequestSchema = z.object({
  model: z.string(),
  messages: z.array(ChatMessageSchema),
  temperature: z.number().min(0).max(2).optional().default(1.0),
  top_p: z.number().min(0).max(1).optional().default(1.0),
  n: z.number().int().min(1).optional().default(1),
  stream: z.boolean().optional().default(false),
  stream_options: StreamOptionsSchema.optional(),
  stop: z.union([z.string(), z.array(z.string())]).optional(),
  max_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().min(-2).max(2).optional().default(0),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  logit_bias: z.record(z.number()).optional(),
  user: z.string().optional(),
  tools: z.array(ToolDefinitionSchema).optional(),
  tool_choice: z.union([z.string(), z.record(z.any())]).optional(),
  response_format: z.record(z.any()).optional(),
  seed: z.number().int().optional(),
  parallel_tool_calls: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
});

// ── Response ──────────────────────────────────────────────────────
export const UsageSchema = z.object({
  prompt_tokens: z.number().default(0),
  completion_tokens: z.number().default(0),
  total_tokens: z.number().default(0),
  reasoning_tokens: z.number().optional(),
});

export const ChatCompletionChoiceSchema = z.object({
  index: z.number(),
  message: ChatMessageSchema,
  finish_reason: z.string().nullable().optional(),
  logprobs: z.any().optional(),
});

export const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.string().default("chat.completion"),
  created: z.number(),
  model: z.string(),
  choices: z.array(ChatCompletionChoiceSchema),
  usage: UsageSchema.optional(),
  system_fingerprint: z.string().optional(),
});

// ── Models List ───────────────────────────────────────────────────
export const ModelSchema = z.object({
  id: z.string(),
  object: z.string().default("model"),
  created: z.number(),
  owned_by: z.string(),
});

export const ListModelsResponseSchema = z.object({
  object: z.string().default("list"),
  data: z.array(ModelSchema),
});

// ── Stream Chunk ──────────────────────────────────────────────────
export const StreamDeltaSchema = z.object({
  role: z.string().optional(),
  content: z.string().nullable().optional(),
  tool_calls: z.array(z.any()).optional(),
});

export const StreamChoiceSchema = z.object({
  index: z.number(),
  delta: StreamDeltaSchema,
  finish_reason: z.string().nullable().optional(),
});

export const StreamChunkSchema = z.object({
  id: z.string(),
  object: z.string().default("chat.completion.chunk"),
  created: z.number(),
  model: z.string(),
  choices: z.array(StreamChoiceSchema),
  usage: UsageSchema.optional(),
});

// ── Inferred Types ────────────────────────────────────────────────
export type FunctionDefinition = z.infer<typeof FunctionDefinitionSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type ChatMessage = z.infer<typeof ChatMessageSchema>;
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type ChatCompletionResponse = z.infer<typeof ChatCompletionResponseSchema>;
export type Usage = z.infer<typeof UsageSchema>;
export type Model = z.infer<typeof ModelSchema>;
export type ListModelsResponse = z.infer<typeof ListModelsResponseSchema>;
export type StreamChunk = z.infer<typeof StreamChunkSchema>;
