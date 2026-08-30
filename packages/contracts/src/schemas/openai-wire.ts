import { z } from "zod";

/**
 * OpenAI Chat Completions wire format.
 * Intentionally permissive: unknown fields pass through untouched so we don't
 * break when providers add new response shapes.
 */

export const OpenAIMessageContentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).passthrough(),
  z
    .object({
      type: z.literal("image_url"),
      image_url: z
        .object({ url: z.string(), detail: z.string().optional() })
        .passthrough(),
    })
    .passthrough(),
  z.record(z.unknown()),
]);

export const OpenAIToolCall = z
  .object({
    id: z.string(),
    type: z.literal("function").default("function"),
    function: z
      .object({
        name: z.string(),
        arguments: z.string().default(""),
      })
      .passthrough(),
  })
  .passthrough();

export type OpenAIToolCall = z.infer<typeof OpenAIToolCall>;

export const OpenAIMessage = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z
      .union([z.string(), z.array(OpenAIMessageContentPart), z.null()])
      .optional(),
    name: z.string().optional(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(OpenAIToolCall).optional(),
  })
  .passthrough();

export type OpenAIMessage = z.infer<typeof OpenAIMessage>;

export const OpenAIToolDefinition = z
  .object({
    type: z.literal("function"),
    function: z
      .object({
        name: z.string(),
        description: z.string().optional(),
        parameters: z.record(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const OpenAIChatCompletionRequest = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAIMessage).min(1),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    logit_bias: z.record(z.number()).optional(),
    user: z.string().optional(),
    seed: z.number().int().optional(),
    tools: z.array(OpenAIToolDefinition).optional(),
    tool_choice: z.unknown().optional(),
    response_format: z.record(z.unknown()).optional(),
    // Deliberately looser than ReasoningEffortSchema: upstreams accept
    // vocabularies beyond minimal/low/medium/high (e.g. "none", "xhigh"), so
    // the proxy passes unknown values through verbatim. Conversion paths
    // narrow via asReasoningEffort and ignore values they don't recognize.
    reasoning_effort: z.string().optional(),
    n: z.number().int().positive().optional(),
  })
  .passthrough();

export type OpenAIChatCompletionRequest = z.infer<
  typeof OpenAIChatCompletionRequest
>;

export const OpenAIChoice = z
  .object({
    index: z.number().int(),
    message: OpenAIMessage,
    finish_reason: z.string().nullable().optional(),
    logprobs: z.unknown().optional(),
  })
  .passthrough();

export const OpenAIUsage = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

export const OpenAIChatCompletionResponse = z
  .object({
    id: z.string(),
    object: z.string().default("chat.completion"),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(OpenAIChoice),
    usage: OpenAIUsage.optional(),
    system_fingerprint: z.string().optional(),
  })
  .passthrough();

export type OpenAIChatCompletionResponse = z.infer<
  typeof OpenAIChatCompletionResponse
>;

/**
 * OpenAI Responses API request (subset).
 * Permissive: unknown fields pass through so clients like Codex keep working.
 */
export const OpenAIResponsesRequest = z
  .object({
    model: z.string().min(1),
    input: z.unknown().optional(),
    instructions: z.string().optional(),
    temperature: z.number().optional(),
    top_p: z.number().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional(),
    stop: z.union([z.string(), z.array(z.string())]).optional(),
    presence_penalty: z.number().optional(),
    frequency_penalty: z.number().optional(),
    user: z.string().optional(),
    seed: z.number().int().optional(),
    tools: z.array(z.unknown()).optional(),
    tool_choice: z.unknown().optional(),
    parallel_tool_calls: z.boolean().optional(),
    metadata: z.record(z.unknown()).optional(),
    store: z.boolean().optional(),
    previous_response_id: z.string().optional(),
    text: z.unknown().optional(),
    reasoning: z.unknown().optional(),
    truncation: z.unknown().optional(),
    include: z.array(z.string()).optional(),
  })
  .passthrough();

export type OpenAIResponsesRequest = z.infer<typeof OpenAIResponsesRequest>;
