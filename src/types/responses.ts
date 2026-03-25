/**
 * Open Responses API type definitions (Zod schemas).
 * Based on https://openresponses.org/specification
 */
import { z } from "zod";

// ── Input Items ───────────────────────────────────────────────────
export const InputTextContentSchema = z.object({
  type: z.literal("input_text"),
  text: z.string(),
});

export const OutputTextContentSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.any()).optional(),
});

export const UserMessageItemSchema = z.object({
  type: z.literal("message"),
  role: z.literal("user"),
  content: z.union([z.string(), z.array(z.any())]),
});

export const SystemMessageItemSchema = z.object({
  type: z.literal("message"),
  role: z.literal("system"),
  content: z.union([z.string(), z.array(z.any())]),
});

export const DeveloperMessageItemSchema = z.object({
  type: z.literal("message"),
  role: z.literal("developer"),
  content: z.union([z.string(), z.array(z.any())]),
});

export const AssistantMessageItemSchema = z.object({
  type: z.literal("message"),
  role: z.literal("assistant"),
  content: z.union([z.string(), z.array(z.any())]),
});

export const FunctionCallItemSchema = z.object({
  type: z.literal("function_call"),
  id: z.string().optional(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
});

export const FunctionCallOutputItemSchema = z.object({
  type: z.literal("function_call_output"),
  call_id: z.string(),
  output: z.string(),
});

export const InputItemSchema = z.union([
  UserMessageItemSchema,
  SystemMessageItemSchema,
  DeveloperMessageItemSchema,
  AssistantMessageItemSchema,
  FunctionCallItemSchema,
  FunctionCallOutputItemSchema,
  z.record(z.any()), // Catch-all for future item types
]);

// ── Tool Definitions ──────────────────────────────────────────────
export const ResponseToolSchema = z.object({
  type: z.literal("function"),
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.any()).optional(),
  strict: z.boolean().optional(),
});

// ── Request ───────────────────────────────────────────────────────
export const CreateResponseRequestSchema = z.object({
  model: z.string(),
  input: z.union([z.string(), z.array(InputItemSchema)]),
  instructions: z.string().optional(),
  tools: z.array(ResponseToolSchema).optional(),
  tool_choice: z.union([z.string(), z.record(z.any())]).optional(),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  max_output_tokens: z.number().int().positive().optional(),
  presence_penalty: z.number().optional(),
  frequency_penalty: z.number().optional(),
  metadata: z.record(z.string()).optional(),
  stream: z.boolean().optional().default(false),
  parallel_tool_calls: z.boolean().optional(),
  reasoning: z.record(z.any()).optional(),
  text: z.record(z.any()).optional(),
  truncation: z.string().optional(),
  store: z.boolean().optional(),
  previous_response_id: z.string().optional(),
});

// ── Output Items ──────────────────────────────────────────────────
export const OutputMessageItemSchema = z.object({
  type: z.literal("message"),
  id: z.string(),
  role: z.literal("assistant"),
  status: z.string().default("completed"),
  content: z.array(z.any()),
});

export const OutputFunctionCallItemSchema = z.object({
  type: z.literal("function_call"),
  id: z.string(),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  status: z.string().default("completed"),
});

export const OutputItemUnionSchema = z.union([
  OutputMessageItemSchema,
  OutputFunctionCallItemSchema,
  z.record(z.any()),
]);

// ── Response Object ───────────────────────────────────────────────
export const ResponseUsageSchema = z.object({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  total_tokens: z.number().default(0),
});

export const ResponseObjectSchema = z.object({
  id: z.string(),
  object: z.literal("response").default("response"),
  created_at: z.number(),
  model: z.string(),
  status: z.enum(["completed", "failed", "in_progress", "cancelled"]).default("completed"),
  output: z.array(OutputItemUnionSchema),
  usage: ResponseUsageSchema.optional(),
  metadata: z.record(z.string()).optional(),
  error: z.any().optional(),
});

// ── Inferred Types ────────────────────────────────────────────────
export type CreateResponseRequest = z.infer<typeof CreateResponseRequestSchema>;
export type ResponseObject = z.infer<typeof ResponseObjectSchema>;
export type InputItem = z.infer<typeof InputItemSchema>;
export type OutputItem = z.infer<typeof OutputItemUnionSchema>;
export type ResponseUsage = z.infer<typeof ResponseUsageSchema>;
export type ResponseTool = z.infer<typeof ResponseToolSchema>;
