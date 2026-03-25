import { describe, test, expect } from "bun:test";
import {
  anthropicToOpenaiRequest,
  openaiToAnthropicRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicResponse,
  responsesToOpenaiRequest,
  openaiToResponsesResponse,
  genaiToOpenaiRequest,
  openaiToGenaiResponse,
} from "../../src/core/format-converters.ts";

describe("Anthropic <-> OpenAI Converters", () => {
  test("anthropicToOpenaiRequest converts basic message", () => {
    const anthropicReq = {
      model: "claude-3",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 1024,
      system: "You are helpful",
    };
    const result = anthropicToOpenaiRequest(anthropicReq);
    expect(result.model).toBe("claude-3");
    expect(result.messages.length).toBe(2); // system + user
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("You are helpful");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("Hello");
    expect(result.max_tokens).toBe(1024);
  });

  test("openaiToAnthropicRequest converts basic message", () => {
    const openaiReq = {
      model: "gpt-4",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
      max_tokens: 512,
    };
    const result = openaiToAnthropicRequest(openaiReq);
    expect(result.model).toBe("gpt-4");
    expect(result.system).toBe("You are helpful");
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.max_tokens).toBe(512);
  });

  test("anthropicToOpenaiResponse converts response", () => {
    const anthropicResp = {
      id: "msg-123",
      content: [{ type: "text", text: "Hello back" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 10 },
    };
    const result = anthropicToOpenaiResponse(anthropicResp, "claude-3");
    expect(result.object).toBe("chat.completion");
    expect(result.choices[0].message.content).toBe("Hello back");
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.usage.prompt_tokens).toBe(5);
  });

  test("openaiToAnthropicResponse converts response", () => {
    const openaiResp = {
      id: "chatcmpl-123",
      choices: [{ message: { role: "assistant", content: "Sure!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = openaiToAnthropicResponse(openaiResp, "gpt-4");
    expect(result.type).toBe("message");
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("Sure!");
    expect(result.stop_reason).toBe("end_turn");
  });

  test("tool calls convert bidirectionally", () => {
    const anthropicReq = {
      model: "claude-3",
      messages: [{
        role: "assistant",
        content: [
          { type: "text", text: "Let me search" },
          { type: "tool_use", id: "call-1", name: "search", input: { query: "test" } },
        ],
      }, {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "Results here" },
        ],
      }],
      max_tokens: 1024,
    };

    const openai = anthropicToOpenaiRequest(anthropicReq);
    // assistant (with tool_calls) + tool (tool_result) = 2 messages
    // No user text since the user message only contains tool_result blocks
    expect(openai.messages.length).toBe(2);
    expect(openai.messages[0].role).toBe("assistant");
    expect(openai.messages[0].tool_calls).toBeDefined();
    expect(openai.messages[1].role).toBe("tool");
  });
});

describe("Responses <-> OpenAI Converters", () => {
  test("responsesToOpenaiRequest with string input", () => {
    const req = { model: "gpt-4", input: "Hello!", instructions: "Be brief" };
    const result = responsesToOpenaiRequest(req);
    expect(result.model).toBe("gpt-4");
    expect(result.messages.length).toBe(2); // system (instructions) + user
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("Be brief");
    expect(result.messages[1].role).toBe("user");
    expect(result.messages[1].content).toBe("Hello!");
  });

  test("responsesToOpenaiRequest with array input", () => {
    const req = {
      model: "gpt-4",
      input: [
        { type: "message", role: "user", content: "Hello" },
        { type: "message", role: "assistant", content: "Hi there" },
        { type: "message", role: "user", content: "How are you?" },
      ],
    };
    const result = responsesToOpenaiRequest(req);
    expect(result.messages.length).toBe(3);
  });

  test("openaiToResponsesResponse converts correctly", () => {
    const openaiResp = {
      id: "chatcmpl-abc",
      choices: [{ message: { role: "assistant", content: "I am fine!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = openaiToResponsesResponse(openaiResp, "gpt-4");
    expect(result.object).toBe("response");
    expect(result.status).toBe("completed");
    expect(result.output.length).toBeGreaterThan(0);
    // Should have a message output item
    const msgItem = result.output.find((o: any) => o.type === "message");
    expect(msgItem).toBeDefined();
    expect(msgItem.content[0].type).toBe("output_text");
    expect(msgItem.content[0].text).toBe("I am fine!");
  });
});

describe("GenAI <-> OpenAI Converters", () => {
  test("genaiToOpenaiRequest with string contents", () => {
    const req = { model: "gemini-pro", contents: "What is AI?" };
    const result = genaiToOpenaiRequest(req);
    expect(result.model).toBe("gemini-pro");
    expect(result.messages.length).toBe(1);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("What is AI?");
  });

  test("genaiToOpenaiRequest with systemInstruction", () => {
    const req = {
      model: "gemini-pro",
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      systemInstruction: "Be helpful",
    };
    const result = genaiToOpenaiRequest(req);
    expect(result.messages[0].role).toBe("system");
    expect(result.messages[0].content).toBe("Be helpful");
    expect(result.messages[1].role).toBe("user");
  });

  test("openaiToGenaiResponse converts correctly", () => {
    const openaiResp = {
      choices: [{ message: { role: "assistant", content: "AI is cool" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
    };
    const result = openaiToGenaiResponse(openaiResp, "gemini-pro");
    expect(result.candidates).toBeDefined();
    expect(result.candidates[0].content.role).toBe("model");
    expect(result.candidates[0].content.parts[0].text).toBe("AI is cool");
    expect(result.usageMetadata.totalTokenCount).toBe(15);
  });
});
