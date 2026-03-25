/**
 * Format converters for converting between OpenAI, Anthropic, Responses, and GenAI formats.
 * OpenAI is the "lingua franca" — all conversions go through OpenAI as intermediate.
 */

const TEXT_BLOCK = "text";
const TOOL_USE_BLOCK = "tool_use";
const TOOL_RESULT_BLOCK = "tool_result";

function jsonCompact(value: unknown): string {
  try { return JSON.stringify(value); } catch { return JSON.stringify(String(value)); }
}

function parseArguments(args: unknown): Record<string, unknown> {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) return args as Record<string, unknown>;
  if (!args) return {};
  if (typeof args === "string") {
    try { const p = JSON.parse(args); if (typeof p === "object" && !Array.isArray(p)) return p; } catch {}
    return { _raw: args };
  }
  return { value: args };
}

// ── Anthropic <-> OpenAI ──────────────────────────────────────────

function anthropicBlockToText(block: Record<string, any>): string {
  const btype = block.type;
  if (btype === TEXT_BLOCK) return block.text || "";
  if (btype === TOOL_RESULT_BLOCK) {
    const inner = block.content;
    if (Array.isArray(inner)) return inner.filter(b => typeof b === "object").map(anthropicBlockToText).join("");
    if (typeof inner === "string") return inner;
    return String(inner || "");
  }
  if (btype === TOOL_USE_BLOCK) return `[tool_use:${block.name || "tool"}]`;
  return jsonCompact(block);
}

function* iterAnthropicBlocks(content: any): Iterable<Record<string, any>> {
  if (Array.isArray(content)) { for (const b of content) if (typeof b === "object") yield b; }
  else if (typeof content === "object" && content) yield content;
  else if (content != null && content !== "") yield { type: TEXT_BLOCK, text: String(content) };
}

function splitAnthropicUserContent(content: any): { text: string | null; toolMessages: Record<string, any>[] } {
  const textChunks: string[] = [];
  const toolMessages: Record<string, any>[] = [];
  for (const block of iterAnthropicBlocks(content)) {
    if (block.type === TEXT_BLOCK) textChunks.push(block.text || "");
    else if (block.type === TOOL_RESULT_BLOCK) {
      toolMessages.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: typeof block.content === "string" ? block.content : anthropicBlockToText(block),
      });
    } else textChunks.push(anthropicBlockToText(block));
  }
  const text = textChunks.filter(Boolean).join("\n");
  return { text: text || null, toolMessages };
}

function splitAnthropicAssistantContent(content: any): { text: string | null; toolCalls: Record<string, any>[] } {
  const textChunks: string[] = [];
  const toolCalls: Record<string, any>[] = [];
  for (const block of iterAnthropicBlocks(content)) {
    if (block.type === TEXT_BLOCK) textChunks.push(block.text || "");
    else if (block.type === TOOL_USE_BLOCK) {
      toolCalls.push({
        id: block.id || `call_${toolCalls.length}`,
        type: "function",
        function: { name: block.name, arguments: jsonCompact(block.input || {}) },
      });
    } else textChunks.push(anthropicBlockToText(block));
  }
  const text = textChunks.filter(Boolean).join("\n");
  return { text: text || null, toolCalls };
}

export function anthropicToOpenaiRequest(req: Record<string, any>): Record<string, any> {
  const messages: Record<string, any>[] = [];

  // System message
  const sys = req.system;
  if (sys) {
    let sysText = "";
    if (typeof sys === "string") sysText = sys;
    else if (Array.isArray(sys)) sysText = sys.filter(b => typeof b === "object").map(anthropicBlockToText).join("\n");
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  for (const msg of (req.messages || [])) {
    if (msg.role === "assistant") {
      const { text, toolCalls } = splitAnthropicAssistantContent(msg.content);
      const am: Record<string, any> = { role: "assistant", content: text };
      if (toolCalls.length > 0) am.tool_calls = toolCalls;
      messages.push(am);
    } else if (msg.role === "user") {
      const { text, toolMessages } = splitAnthropicUserContent(msg.content);
      messages.push(...toolMessages);
      if (text !== null) messages.push({ role: "user", content: text });
    } else {
      messages.push({ role: msg.role, content: anthropicBlockToText({ type: TEXT_BLOCK, text: msg.content }) });
    }
  }

  const result: Record<string, any> = { model: req.model, messages, max_tokens: req.max_tokens };
  if (req.temperature != null) result.temperature = req.temperature;
  if (req.top_p != null) result.top_p = req.top_p;
  if (req.stream != null) result.stream = req.stream;

  if (req.tools) {
    result.tools = req.tools.map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema || {} },
    }));
  }

  if (req.tool_choice) {
    const tc = req.tool_choice;
    if (typeof tc === "object" && tc.type === "tool") {
      result.tool_choice = { type: "function", function: { name: tc.name } };
    } else result.tool_choice = tc;
  }

  if (req.stop_sequences) {
    result.stop = req.stop_sequences.length === 1 ? req.stop_sequences[0] : req.stop_sequences;
  }

  return result;
}

export function openaiToAnthropicRequest(req: Record<string, any>): Record<string, any> {
  const messages: Record<string, any>[] = [];
  const systemSegments: string[] = [];

  for (const msg of (req.messages || [])) {
    const { role, content } = msg;

    if (role === "system") {
      const text = Array.isArray(content)
        ? content.filter((p: any) => typeof p === "object").map((p: any) => p.text || "").join("")
        : content;
      if (text) systemSegments.push(text);
      continue;
    }

    if (role === "tool") {
      messages.push({
        role: "user",
        content: [{
          type: TOOL_RESULT_BLOCK,
          tool_use_id: msg.tool_call_id,
          content: content || "",
          is_error: msg.metadata?.is_error ?? null,
        }],
      });
      continue;
    }

    const targetRole = (role === "assistant" || role === "user") ? role : "user";
    const blocks: Record<string, any>[] = [];

    // Text blocks
    if (typeof content === "string" && content) blocks.push({ type: TEXT_BLOCK, text: content });
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") blocks.push({ type: TEXT_BLOCK, text: part });
        else if (typeof part === "object") {
          if (part.type === TEXT_BLOCK) blocks.push({ type: TEXT_BLOCK, text: part.text || "" });
          else blocks.push({ type: TEXT_BLOCK, text: jsonCompact(part) });
        }
      }
    } else if (content != null) blocks.push({ type: TEXT_BLOCK, text: String(content) });

    // Tool calls
    if (role === "assistant" && msg.tool_calls) {
      for (const call of msg.tool_calls) {
        blocks.push({
          type: TOOL_USE_BLOCK,
          id: call.id,
          name: call.function?.name,
          input: parseArguments(call.function?.arguments),
        });
      }
    }

    // Collapse to string if all text
    let normalizedContent: any;
    if (blocks.length === 0) normalizedContent = "";
    else if (blocks.every(b => b.type === TEXT_BLOCK)) normalizedContent = blocks.map(b => b.text).join("");
    else normalizedContent = blocks;

    messages.push({ role: targetRole, content: normalizedContent });
  }

  const result: Record<string, any> = {
    model: req.model,
    messages,
    max_tokens: req.max_tokens || 1024,
  };

  const systemPrompt = systemSegments.filter(Boolean).join("\n\n");
  if (systemPrompt) result.system = systemPrompt;
  if (req.temperature != null) result.temperature = req.temperature;
  if (req.top_p != null) result.top_p = req.top_p;
  if (req.stream != null) result.stream = req.stream;

  if (req.stop) {
    result.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop];
  }

  if (req.tools) {
    result.tools = req.tools
      .filter((t: any) => t.type === "function")
      .map((t: any) => ({
        name: t.function?.name,
        description: t.function?.description || "",
        input_schema: t.function?.parameters || {},
      }));
  }

  if (req.tool_choice) {
    const tc = req.tool_choice;
    if (typeof tc === "object" && tc.type === "function") {
      result.tool_choice = { type: "tool", name: tc.function?.name };
    } else result.tool_choice = tc;
  }

  return result;
}

export function anthropicToOpenaiResponse(resp: Record<string, any>, model: string): Record<string, any> {
  const contentBlocks = resp.content || [];
  let textContent = "";
  let toolCalls: any[] | null = null;

  for (const block of contentBlocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === TEXT_BLOCK) textContent += (block.text || "");
    else if (block.type === TOOL_USE_BLOCK) {
      if (!toolCalls) toolCalls = [];
      toolCalls.push({
        id: block.id,
        type: "function",
        function: { name: block.name, arguments: jsonCompact(block.input || {}) },
      });
    }
  }

  const stopReason = resp.stop_reason;
  const finishMap: Record<string, string> = { end_turn: "stop", max_tokens: "length", stop_sequence: "stop", tool_use: "tool_calls" };
  const finishReason = toolCalls ? "tool_calls" : (finishMap[stopReason] || "stop");
  const usage = resp.usage || {};

  const message: Record<string, any> = {
    role: "assistant",
    content: toolCalls ? null : textContent,
  };
  if (toolCalls) message.tool_calls = toolCalls;

  return {
    id: resp.id || `chatcmpl-${Math.floor(Date.now() / 1000)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    },
  };
}

export function openaiToAnthropicResponse(resp: Record<string, any>, model: string): Record<string, any> {
  const choice = (resp.choices || [{}])[0];
  const message = choice.message || {};
  const contentBlocks: Record<string, any>[] = [];

  const content = message.content;
  if (typeof content === "string" && content) contentBlocks.push({ type: TEXT_BLOCK, text: content });
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "object" && part.type === TEXT_BLOCK) contentBlocks.push({ type: TEXT_BLOCK, text: part.text || "" });
      else if (typeof part === "string") contentBlocks.push({ type: TEXT_BLOCK, text: part });
    }
  }

  for (const tc of (message.tool_calls || [])) {
    contentBlocks.push({
      type: TOOL_USE_BLOCK,
      id: tc.id,
      name: tc.function?.name,
      input: parseArguments(tc.function?.arguments),
    });
  }

  const finishReason = choice.finish_reason || "stop";
  const stopReasonMap: Record<string, string> = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use" };
  const usage = resp.usage || {};

  return {
    id: resp.id || `msg-${Math.floor(Date.now() / 1000)}`,
    type: "message",
    role: "assistant",
    model,
    content: contentBlocks,
    stop_reason: stopReasonMap[finishReason] || "end_turn",
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

// ── Responses <-> OpenAI ──────────────────────────────────────────

export function responsesToOpenaiRequest(req: Record<string, any>): Record<string, any> {
  const messages: Record<string, any>[] = [];

  // Instructions become system message
  if (req.instructions) {
    messages.push({ role: "system", content: req.instructions });
  }

  const input = req.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item !== "object") { messages.push({ role: "user", content: String(item) }); continue; }

      if (item.type === "message") {
        const role = item.role === "developer" ? "system" : (item.role || "user");
        const content = typeof item.content === "string"
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map((c: any) => typeof c === "object" && c.text ? c.text : String(c)).join("")
            : String(item.content || "");
        messages.push({ role, content });
      } else if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{
            id: item.call_id,
            type: "function",
            function: { name: item.name, arguments: item.arguments || "{}" },
          }],
        });
      } else if (item.type === "function_call_output") {
        messages.push({ role: "tool", tool_call_id: item.call_id, content: item.output || "" });
      }
    }
  }

  const result: Record<string, any> = { model: req.model, messages };
  if (req.temperature != null) result.temperature = req.temperature;
  if (req.top_p != null) result.top_p = req.top_p;
  if (req.max_output_tokens != null) result.max_tokens = req.max_output_tokens;
  if (req.presence_penalty != null) result.presence_penalty = req.presence_penalty;
  if (req.frequency_penalty != null) result.frequency_penalty = req.frequency_penalty;
  if (req.stream != null) result.stream = req.stream;

  if (req.tools) {
    result.tools = req.tools.map((t: any) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters || {} },
    }));
  }

  if (req.tool_choice) result.tool_choice = req.tool_choice;

  return result;
}

export function openaiToResponsesResponse(resp: Record<string, any>, model: string): Record<string, any> {
  const choice = (resp.choices || [{}])[0];
  const message = choice.message || {};
  const output: Record<string, any>[] = [];

  const msgId = `msg_${Date.now().toString(36)}`;

  // Build output items
  if (message.tool_calls && message.tool_calls.length > 0) {
    // Add tool calls as function_call output items
    for (const tc of message.tool_calls) {
      output.push({
        type: "function_call",
        id: `fc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
        call_id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments || "{}",
        status: "completed",
      });
    }
  }

  // Message output item
  const contentParts: Record<string, any>[] = [];
  if (message.content) {
    contentParts.push({ type: "output_text", text: message.content, annotations: [] });
  }

  output.push({
    type: "message",
    id: msgId,
    role: "assistant",
    status: "completed",
    content: contentParts,
  });

  const usage = resp.usage || {};

  return {
    id: resp.id || `resp_${Date.now().toString(36)}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model,
    status: "completed",
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
  };
}

// ── GenAI <-> OpenAI ──────────────────────────────────────────────

export function genaiToOpenaiRequest(req: Record<string, any>): Record<string, any> {
  const messages: Record<string, any>[] = [];

  // System instruction
  if (req.systemInstruction) {
    let sysText = "";
    if (typeof req.systemInstruction === "string") sysText = req.systemInstruction;
    else if (req.systemInstruction.parts) {
      sysText = req.systemInstruction.parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join("\n");
    }
    if (sysText) messages.push({ role: "system", content: sysText });
  }

  // Contents
  const contents = req.contents;
  if (typeof contents === "string") {
    messages.push({ role: "user", content: contents });
  } else if (Array.isArray(contents)) {
    for (const content of contents) {
      const role = content.role === "model" ? "assistant" : (content.role || "user");
      const parts = content.parts || [];
      const textParts = parts.filter((p: any) => p.text).map((p: any) => p.text).join("");

      const toolCalls: any[] = [];
      const toolResults: any[] = [];

      for (const part of parts) {
        if (part.functionCall) {
          toolCalls.push({
            id: `call_${Math.random().toString(36).slice(2, 8)}`,
            type: "function",
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args || {}),
            },
          });
        }
        if (part.functionResponse) {
          toolResults.push({
            role: "tool",
            tool_call_id: `call_${part.functionResponse.name}`,
            content: JSON.stringify(part.functionResponse.response || {}),
          });
        }
      }

      if (toolResults.length > 0) {
        messages.push(...toolResults);
      } else {
        const msg: Record<string, any> = { role, content: textParts || null };
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        messages.push(msg);
      }
    }
  }

  const result: Record<string, any> = { model: req.model || "", messages };

  const gc = req.generationConfig;
  if (gc) {
    if (gc.temperature != null) result.temperature = gc.temperature;
    if (gc.topP != null) result.top_p = gc.topP;
    if (gc.maxOutputTokens != null) result.max_tokens = gc.maxOutputTokens;
    if (gc.stopSequences) result.stop = gc.stopSequences;
  }

  if (req.tools) {
    const tools: any[] = [];
    for (const tool of req.tools) {
      if (tool.functionDeclarations) {
        for (const fd of tool.functionDeclarations) {
          tools.push({
            type: "function",
            function: { name: fd.name, description: fd.description, parameters: fd.parameters || {} },
          });
        }
      }
    }
    if (tools.length > 0) result.tools = tools;
  }

  return result;
}

export function openaiToGenaiResponse(resp: Record<string, any>, model: string): Record<string, any> {
  const choice = (resp.choices || [{}])[0];
  const message = choice.message || {};
  const parts: Record<string, any>[] = [];

  if (message.content) {
    parts.push({ text: message.content });
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let args: Record<string, any> = {};
      try { args = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      parts.push({
        functionCall: { name: tc.function?.name, args },
      });
    }
  }

  const usage = resp.usage || {};
  const finishMap: Record<string, string> = {
    stop: "STOP",
    length: "MAX_TOKENS",
    tool_calls: "TOOL_CALLS",
  };

  return {
    candidates: [{
      content: { role: "model", parts },
      finishReason: finishMap[choice.finish_reason] || "STOP",
      index: 0,
    }],
    usageMetadata: {
      promptTokenCount: usage.prompt_tokens || 0,
      candidatesTokenCount: usage.completion_tokens || 0,
      totalTokenCount: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
    },
    modelVersion: model,
  };
}
