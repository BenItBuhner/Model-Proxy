"use client";

import { thinkingFromReasoningEffort } from "@model-proxy/contracts/schemas/reasoning.ts";
import type {
  ParamState,
  ThreadMessage,
  ThreadMessageAnthropic,
  ThreadMessageOpenAI,
  ToolDefinition,
} from "./test-session";

/**
 * Translate the session state into a wire-ready request body for the chosen
 * protocol. The proxy will validate against its own Zod schemas, so we keep
 * the transform minimal and strip out anything that would be rejected.
 */
export function buildRequestBody(
  protocol: "openai" | "anthropic",
  params: ParamState,
  messages: ThreadMessage[],
  tools: ToolDefinition[],
  model: string,
): Record<string, unknown> {
  if (protocol === "openai") return buildOpenAI(params, messages, tools, model);
  return buildAnthropic(params, messages, tools, model);
}

function buildOpenAI(
  params: ParamState,
  messages: ThreadMessage[],
  tools: ToolDefinition[],
  model: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => sanitizeOpenAIMessage(m as ThreadMessageOpenAI)),
  };
  if (params.temperature !== undefined) body["temperature"] = params.temperature;
  if (params.top_p !== undefined) body["top_p"] = params.top_p;
  if (params.max_tokens !== undefined) body["max_tokens"] = params.max_tokens;
  if (params.presence_penalty !== undefined)
    body["presence_penalty"] = params.presence_penalty;
  if (params.frequency_penalty !== undefined)
    body["frequency_penalty"] = params.frequency_penalty;
  if (params.stop !== undefined && params.stop.length > 0)
    body["stop"] = params.stop;
  if (params.response_format_json === true)
    body["response_format"] = { type: "json_object" };
  if (params.reasoning_effort !== undefined)
    body["reasoning_effort"] = params.reasoning_effort;
  if (tools.length > 0) {
    body["tools"] = tools.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }
  return body;
}

function sanitizeOpenAIMessage(msg: ThreadMessageOpenAI): Record<string, unknown> {
  const out: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };
  if (msg.tool_calls !== undefined && msg.tool_calls.length > 0) {
    out["tool_calls"] = msg.tool_calls;
  }
  if (msg.tool_call_id !== undefined) out["tool_call_id"] = msg.tool_call_id;
  return out;
}

function buildAnthropic(
  params: ParamState,
  messages: ThreadMessage[],
  tools: ToolDefinition[],
  model: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => sanitizeAnthropicMessage(m as ThreadMessageAnthropic)),
    max_tokens: params.max_tokens ?? 1024,
  };
  if (params.system !== undefined && params.system.length > 0) {
    body["system"] = params.system;
  }
  if (params.temperature !== undefined) body["temperature"] = params.temperature;
  if (params.top_p !== undefined) body["top_p"] = params.top_p;
  if (params.reasoning_effort !== undefined) {
    const thinking = thinkingFromReasoningEffort(params.reasoning_effort, params.max_tokens);
    if (thinking !== undefined) body["thinking"] = thinking;
  }
  if (params.stop !== undefined && params.stop.length > 0)
    body["stop_sequences"] = params.stop;
  if (tools.length > 0) {
    body["tools"] = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));
  }
  return body;
}

function sanitizeAnthropicMessage(
  msg: ThreadMessageAnthropic,
): Record<string, unknown> {
  return { role: msg.role, content: msg.content };
}
