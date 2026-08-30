import { z } from "zod";

/**
 * Anthropic Messages API wire format.
 * Intentionally permissive: unknown fields pass through.
 */

export const AnthropicTextBlock = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();

export const AnthropicImageSource = z
  .object({
    type: z.literal("base64"),
    media_type: z.string(),
    data: z.string(),
  })
  .passthrough();

export const AnthropicImageBlock = z
  .object({ type: z.literal("image"), source: AnthropicImageSource })
  .passthrough();

export const AnthropicToolUseBlock = z
  .object({
    type: z.literal("tool_use"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })
  .passthrough();

export type AnthropicToolUseBlock = z.infer<typeof AnthropicToolUseBlock>;

export const AnthropicToolResultBlock = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]).optional(),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const AnthropicContentBlock = z.union([
  AnthropicTextBlock,
  AnthropicImageBlock,
  AnthropicToolUseBlock,
  AnthropicToolResultBlock,
  z.record(z.unknown()),
]);

export type AnthropicContentBlock = z.infer<typeof AnthropicContentBlock>;

export const AnthropicMessage = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.union([z.string(), z.array(AnthropicContentBlock)]),
  })
  .passthrough();

export type AnthropicMessage = z.infer<typeof AnthropicMessage>;

export const AnthropicToolDefinition = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.unknown()),
  })
  .passthrough();

export const AnthropicMessagesRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(AnthropicMessage).min(1),
    system: z
      .union([z.string(), z.array(AnthropicContentBlock)])
      .optional(),
    max_tokens: z.number().int().positive(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    top_k: z.number().int().optional(),
    thinking: z.record(z.unknown()).optional(),
    stream: z.boolean().optional(),
    stop_sequences: z.array(z.string()).optional(),
    tools: z.array(AnthropicToolDefinition).optional(),
    tool_choice: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof AnthropicMessagesRequest>;

export const AnthropicUsage = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const AnthropicMessagesResponse = z
  .object({
    id: z.string(),
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z.array(AnthropicContentBlock),
    model: z.string(),
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
    usage: AnthropicUsage.optional(),
  })
  .passthrough();

export type AnthropicMessagesResponse = z.infer<
  typeof AnthropicMessagesResponse
>;
