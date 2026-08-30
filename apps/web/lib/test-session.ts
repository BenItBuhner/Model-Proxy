"use client";

import type { ReasoningEffort } from "@model-proxy/contracts/schemas/reasoning.ts";

/**
 * Persistent, single-session state for the Test tab. Stored in localStorage
 * so a refresh preserves the thread + params + tool definitions.
 *
 * Intentionally decoupled from React; `use-test-session` is a thin hook that
 * subscribes and persists on change.
 */

import type { Protocol } from "./test-dispatch";

export type { Protocol };
export type EnforceOverride = "default" | "force-on" | "force-off";

export interface ThreadMessageOpenAI {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  /** Present on assistant turns that emit tool calls. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** Present on tool replies. */
  tool_call_id?: string;
}

export interface ThreadMessageAnthropic {
  role: "user" | "assistant";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          }
        | {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          }
      >;
}

export type ThreadMessage = ThreadMessageOpenAI | ThreadMessageAnthropic;

export interface ToolDefinition {
  /** Stable id so we can edit/delete. */
  id: string;
  name: string;
  description: string;
  /** Parameters as JSON Schema object. */
  parameters: Record<string, unknown>;
}

export interface ParamState {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop?: string[];
  response_format_json?: boolean;
  reasoning_effort?: ReasoningEffort;
  stream: boolean;
  enforceOverride: EnforceOverride;
  /** Anthropic-only system prompt */
  system?: string;
}

export interface TestSessionState {
  protocol: Protocol;
  logicalModel: string;
  messages: ThreadMessage[];
  tools: ToolDefinition[];
  params: ParamState;
}

const STORAGE_KEY = "mp_test_session_v1";

const DEFAULT_TOOLS: ToolDefinition[] = [
  {
    id: "preset-weather",
    name: "get_weather",
    description: "Look up the current weather for a given city.",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name, e.g. 'London'" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["city"],
    },
  },
  {
    id: "preset-calc",
    name: "calculator",
    description: "Evaluate a basic arithmetic expression.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "e.g. '2 + 2 * 3'" },
      },
      required: ["expression"],
    },
  },
];

/** Drop placeholder user rows (from the old + user control) so they do not linger in the thread. */
function stripEmptyDraftUserMessages(messages: ThreadMessage[]): ThreadMessage[] {
  return messages.filter((m) => {
    if (m.role !== "user") return true;
    const c = m.content;
    if (c === null || c === undefined) return false;
    if (typeof c === "string") return c.trim().length > 0;
    return true;
  });
}

function defaultState(): TestSessionState {
  return {
    protocol: "openai",
    logicalModel: "",
    messages: [],
    tools: DEFAULT_TOOLS,
    params: {
      temperature: 0.2,
      max_tokens: 256,
      stream: false,
      enforceOverride: "default",
    },
  };
}

export function loadSession(): TestSessionState {
  if (typeof window === "undefined") return defaultState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return defaultState();
    const parsed = JSON.parse(raw) as Partial<TestSessionState>;
    const fresh = defaultState();
    const rawMessages = Array.isArray(parsed.messages)
      ? (parsed.messages as ThreadMessage[])
      : fresh.messages;
    return {
      protocol: parsed.protocol ?? fresh.protocol,
      logicalModel: parsed.logicalModel ?? fresh.logicalModel,
      messages: stripEmptyDraftUserMessages(rawMessages),
      tools: Array.isArray(parsed.tools) ? (parsed.tools as ToolDefinition[]) : fresh.tools,
      params: { ...fresh.params, ...(parsed.params ?? {}) },
    };
  } catch {
    return defaultState();
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function saveSession(state: TestSessionState): void {
  if (typeof window === "undefined") return;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // quota exhausted or disabled storage — ignore
    }
  }, 250);
}

export function newToolId(): string {
  return `tool-${Math.random().toString(36).slice(2, 10)}`;
}
