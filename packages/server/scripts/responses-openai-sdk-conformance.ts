/**
 * Official OpenAI SDK conformance harness for the local Responses surface.
 *
 * Usage:
 *   CLIENT_API_KEY=... MODEL_PROXY_BASE=http://127.0.0.1:9876/v1 \
 *     bun run scripts/responses-openai-sdk-conformance.ts
 *
 * The default model is intentionally GLM, matching the supported runtime
 * validation target for this project.
 */

import OpenAI from "openai";

const baseURL = process.env.MODEL_PROXY_BASE ?? "http://127.0.0.1:9876/v1";
const apiKey = process.env.CLIENT_API_KEY;
const model = process.env.MODEL_PROXY_MODEL ?? "glm-5.2";
if (apiKey === undefined || apiKey.trim() === "") {
  console.error("CLIENT_API_KEY is required");
  process.exit(2);
}

const client = new OpenAI({ apiKey, baseURL });
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail: string): void {
  if (condition) passed += 1;
  else failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

async function main(): Promise<void> {
  const chat = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Reply with exactly CHAT_SDK_OK" }],
    max_tokens: 20,
    temperature: 0,
  });
  check("chat JSON", (chat.choices[0]?.message.content ?? "").length > 0, chat.choices[0]?.message.content ?? "empty");

  let chatStreamText = "";
  const chatStream = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: "Reply with exactly CHAT_STREAM_SDK_OK" }],
    max_tokens: 20,
    temperature: 0,
    stream: true,
  });
  for await (const chunk of chatStream) chatStreamText += chunk.choices[0]?.delta.content ?? "";
  check("chat streaming", chatStreamText.length > 0, chatStreamText);

  const response = await client.responses.create({
    model,
    input: "Reply with exactly RESPONSES_SDK_OK",
    max_output_tokens: 20,
    temperature: 0,
    metadata: { harness: "official-openai-sdk" },
  });
  check("responses JSON", response.status === "completed" && response.output_text.length > 0, response.output_text);
  check("responses metadata", response.metadata?.harness === "official-openai-sdk", JSON.stringify(response.metadata));

  const continued = await client.responses.create({
    model,
    previous_response_id: response.id,
    input: "Reply with exactly RESPONSES_CONTINUED_SDK_OK",
    max_output_tokens: 20,
    temperature: 0,
  });
  check("previous_response_id", continued.status === "completed" && continued.output_text.length > 0, continued.output_text);

  const toolResponse = await client.responses.create({
    model,
    input: "Call lookup for Tokyo. Do not answer normally.",
    max_output_tokens: 100,
    temperature: 0,
    tool_choice: "required",
    tools: [{
      type: "function",
      name: "lookup",
      description: "Look up a location",
      parameters: {
        type: "object",
        properties: { location: { type: "string" } },
        required: ["location"],
        additionalProperties: false,
      },
      strict: true,
    }],
  });
  const functionCall = toolResponse.output.find((item) => item.type === "function_call");
  check("function call", functionCall?.type === "function_call", JSON.stringify(functionCall));
  if (functionCall?.type === "function_call") {
    const loop = await client.responses.create({
      model,
      previous_response_id: toolResponse.id,
      input: [{
        type: "function_call_output",
        call_id: functionCall.call_id,
        output: JSON.stringify({ result: "Tokyo lookup complete" }),
      }],
      max_output_tokens: 50,
      temperature: 0,
    });
    check("function loop", loop.status === "completed" && loop.output.length > 0, loop.output_text);
  }

  let responseStreamText = "";
  let sawCompleted = false;
  const responseStream = await client.responses.create({
    model,
    input: "Reply with exactly RESPONSES_STREAM_SDK_OK",
    max_output_tokens: 20,
    temperature: 0,
    stream: true,
  });
  for await (const event of responseStream) {
    if (event.type === "response.output_text.delta") responseStreamText += event.delta;
    if (event.type === "response.completed") sawCompleted = true;
  }
  check("responses streaming", sawCompleted && responseStreamText.length > 0, responseStreamText);

  const retrieved = await client.responses.retrieve(response.id);
  check("responses retrieve", retrieved.id === response.id && retrieved.object === "response", retrieved.id);
  const deleted = await client.responses.delete(response.id);
  check("responses delete", deleted.id === response.id && deleted.deleted === true, JSON.stringify(deleted));

  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
