#!/usr/bin/env bun
/**
 * Responses API conformance client.
 * Exit 0 on all pass, exit 1 on failure.
 * Usage:
 *   MODEL_PROXY_BASE=http://127.0.0.1:9876 CLIENT_API_KEY=... bun run scripts/responses-conformance.ts
 */

const BASE = process.env.MODEL_PROXY_BASE ?? "http://127.0.0.1:9876";
const WS_BASE = BASE.replace(/^http/, "ws");
const KEY = process.env.CLIENT_API_KEY ?? "";
const MODEL = "glm-5.2";

interface TestResult { name: string; pass: boolean; detail?: string }
const results: TestResult[] = [];

function report(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function jsonFetch(path: string, body: unknown): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    clearTimeout(timer);
    const json = (await res.json()) as Record<string, unknown>;
    return { status: res.status, ...json };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function getText(resp: Record<string, unknown>): string {
  if (typeof resp["output_text"] === "string") return resp["output_text"];
  const output = Array.isArray(resp["output"]) ? resp["output"] : [];
  for (const item of output) {
    if (typeof item === "object" && item !== null) {
      const o = item as Record<string, unknown>;
      if (o["type"] === "message") {
        const content = Array.isArray(o["content"]) ? o["content"] : [];
        for (const part of content) {
          if (typeof part === "object" && part !== null) {
            const p = part as Record<string, unknown>;
            if (p["type"] === "output_text") return String(p["text"] ?? "");
          }
        }
      }
    }
  }
  return "";
}

async function wsCollectEvents(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const url = `${WS_BASE}/v1/responses?api_key=${encodeURIComponent(KEY)}`;
    const ws = new WebSocket(url, []);
    const timer = setTimeout(() => { ws.close(); reject(new Error(`WS timeout (${timeoutMs}ms)`)); }, timeoutMs);

    ws.onopen = () => ws.send(JSON.stringify({ type: "response.create", ...payload }));
    ws.onmessage = (msg: MessageEvent) => {
      const text = typeof msg.data === "string" ? msg.data : "";
      events.push(text);
      if (text.includes('"type":"response.completed"')) {
        clearTimeout(timer); ws.close(); resolve(events);
      }
    };
    ws.onerror = () => { clearTimeout(timer); ws.close(); reject(new Error("WS error")); };
    ws.onclose = () => { clearTimeout(timer); if (events.length === 0) reject(new Error("WS closed without events")); };
  });
}

// ── Tests ────────────────────────────────────────────────────────────

async function testHttpNonStreamText(): Promise<void> {
  const resp = await jsonFetch("/v1/responses", {
    model: MODEL, input: "Say exactly OK.", max_output_tokens: 10, temperature: 0,
  });
  const text = getText(resp);
  report("HTTP non-stream text", resp["status"] === "completed" && resp["object"] === "response" && text.length > 0,
    `text="${text.slice(0, 60)}"`);
}

async function testHttpSseStream(): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const res = await fetch(`${BASE}/v1/responses`, {
      method: "POST", signal: ac.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, input: "Say OK.", stream: true, max_output_tokens: 10, temperature: 0 }),
    });
    clearTimeout(timer);
    const text = await res.text();
    report("HTTP SSE stream",
      text.includes("event: response.created") && text.includes("response.output_text.delta") && text.includes("response.completed") && text.length > 100,
      `len=${text.length}`);
  } catch (err) {
    clearTimeout(timer);
    report("HTTP SSE stream", false, String(err instanceof Error ? err.message : err));
  }
}

async function testHttpMultiTurn(): Promise<void> {
  const uid = Math.random().toString(36).slice(2, 8);
  const first = await jsonFetch("/v1/responses", {
    model: MODEL, input: `The word to remember is: ${uid}.`, max_output_tokens: 20, temperature: 0,
  });
  const firstId = first["id"];
  if (typeof firstId !== "string" || !firstId.startsWith("resp_")) {
    report("HTTP multi-turn", false, `first id invalid: ${String(firstId).slice(0, 30)}`);
    return;
  }
  const second = await jsonFetch("/v1/responses", {
    model: MODEL, previous_response_id: firstId,
    input: `Repeat the word I told you.`, max_output_tokens: 30, temperature: 0,
  });
  const statusOk = second["status"] === "completed";
  const text = getText(second).toLowerCase();
  report("HTTP multi-turn with previous_response_id", statusOk,
    `status=${second["status"]} text="${text.slice(0, 60)}"`);
}

async function testHttpToolLoop(): Promise<void> {
  const first = await jsonFetch("/v1/responses", {
    model: MODEL, input: "Use get_weather for Tokyo.", max_output_tokens: 100, temperature: 0,
    tool_choice: "auto",
    tools: [{ type: "function", name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { location: { type: "string" } }, required: ["location"] } }],
  });
  const output = Array.isArray(first["output"]) ? first["output"] : [];
  const fc = output.find((o) => typeof o === "object" && o !== null && (o as Record<string, unknown>)["type"] === "function_call") as Record<string, unknown> | undefined;
  const callId = fc?.["call_id"];
  const firstId = first["id"];

  if (!fc || !callId || typeof firstId !== "string") {
    report("HTTP tool loop", false, `no function_call`);
    return;
  }

  const second = await jsonFetch("/v1/responses", {
    model: MODEL, previous_response_id: firstId,
    input: [
      { type: "function_call_output", call_id: callId, output: JSON.stringify({ temperature: 22, condition: "sunny" }) },
      { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize the weather." }] },
    ],
    max_output_tokens: 50, temperature: 0,
  });
  const statusOk = second["status"] === "completed";
  report("HTTP tool call loop", statusOk,
    `tool_call=y status=${second["status"]} text="${getText(second).slice(0, 40)}"`);
}

async function testWsResponseCreate(): Promise<void> {
  try {
    const events = await wsCollectEvents({
      model: MODEL, input: "Say exactly WSOK.", max_output_tokens: 15, temperature: 0,
    });
    const all = events.join(" ");
    const hasCreated = all.includes('"type":"response.created"');
    const hasDelta = all.includes('"type":"response.output_text.delta"');
    const hasCompleted = all.includes('"type":"response.completed"');
    const hasText = all.toLowerCase().includes("wsok");
    report("WebSocket response.create", hasCreated && hasCompleted && hasText,
      `events=${events.length} completed=${hasCreated}`);
  } catch (err) {
    report("WebSocket response.create", false, String(err instanceof Error ? err.message : err));
  }
}

async function testWsMultiTurn(): Promise<void> {
  try {
    const uid = Math.random().toString(36).slice(2, 8);
    const firstEvents = await wsCollectEvents({
      model: MODEL, input: `The word to remember is: ${uid}.`, max_output_tokens: 20, temperature: 0,
    });
    const last = firstEvents[firstEvents.length - 1] ?? "";
    let respId = "";
    try { const d = JSON.parse(last); respId = d.response?.id ?? ""; } catch { /* ignore */ }
    if (!respId) { report("WS multi-turn", false, "no response id from first"); return; }

    const secondEvents = await wsCollectEvents({
      model: MODEL, previous_response_id: respId,
      input: "Repeat the word.", max_output_tokens: 30, temperature: 0,
    });
    const all = secondEvents.join(" ");
    report("WebSocket multi-turn with previous_response_id", all.includes('"type":"response.completed"'),
      `second_completed=true`);
  } catch (err) {
    report("WebSocket multi-turn with previous_response_id", false, String(err instanceof Error ? err.message : err));
  }
}

async function testChatRegressions(): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "Say OK." }], max_tokens: 10, temperature: 0 }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  const choices = Array.isArray(json["choices"]) ? json["choices"] : [];
  const text = choices.length > 0 ? (choices[0] as Record<string, unknown>)["message"]?.["content"] ?? "" : "";
  report("Chat completions regression", res.status === 200 && typeof text === "string" && text.length > 0,
    `text="${String(text).slice(0, 60)}"`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\nResponses Conformance Client`);
  console.log(`  base: ${BASE}`);
  console.log(`  model: ${MODEL}`);
  console.log(`  api_key: ${KEY ? "configured" : "MISSING"}`);
  console.log();

  const tests = [
    testChatRegressions,
    testHttpNonStreamText,
    testHttpSseStream,
    testHttpMultiTurn,
    testHttpToolLoop,
    testWsResponseCreate,
    testWsMultiTurn,
  ];

  for (const test of tests) {
    try { await test(); } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      report(test.name.replace("bound ", ""), false, `exception: ${msg}`);
    }
  }

  console.log();
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`Results: ${passed} passed, ${failed} failed`);

  for (const r of results) { if (!r.pass) console.log(`  FAIL ${r.name}: ${r.detail ?? ""}`); }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
