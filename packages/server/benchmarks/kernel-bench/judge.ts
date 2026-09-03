#!/usr/bin/env bun
/**
 * Pairwise blind judging for open-ended (creativity/writing) items.
 *
 * For every item, each contestant model answers once (cached in JSONL). Then
 * fusion is compared against each base model by a judge from a THIRD family,
 * in both presentation orders (A/B swapped) to cancel position bias. A win
 * requires the same preference in both orders; otherwise it is a tie.
 *
 *   bun run benchmarks/kernel-bench/judge.ts --n 6 --fusion fusion-max \
 *     --bases glm-5.3,kimi-k3,deepseek-v4-pro-0813 --out /tmp/kernel-bench/creative.jsonl
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { chatCall } from "./client.ts";
import { loadCreativity } from "./datasets.ts";

interface Args { n: number; fusion: string; bases: string[]; out: string; concurrency: number; report?: string }

function parseArgs(argv: string[]): Args {
  const args: Args = { n: 6, fusion: "fusion-max", bases: ["glm-5.3", "kimi-k3", "deepseek-v4-pro-0813"], out: "/tmp/kernel-bench/creative.jsonl", concurrency: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--n") args.n = Number(next());
    else if (a === "--fusion") args.fusion = next();
    else if (a === "--bases") args.bases = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--out") args.out = next();
    else if (a === "--concurrency") args.concurrency = Number(next());
    else if (a === "--report") args.report = next();
  }
  return args;
}

interface AnswerRow { type: "answer"; itemId: string; model: string; content: string; latencyMs: number; ok: boolean }
interface JudgeRow { type: "judgment"; itemId: string; fusion: string; base: string; judge: string; order: "fusion_first" | "base_first"; winner: "A" | "B" | "tie"; rationale: string }

const JUDGE_SYSTEM = `You are an exacting editor judging two anonymous responses to the same creative brief. Judge ONLY on: (1) how completely and precisely the brief's explicit constraints are met (length, form, forbidden words, required elements); (2) craft — specificity of detail, freshness of language, control of tone, absence of clichés and filler; (3) emotional or intellectual effect on a discerning reader. Ignore length beyond the brief's requirement and ignore which response comes first. Output a fenced json block exactly like:
\`\`\`json
{"winner": "A" | "B" | "tie", "rationale": "<2-3 sentences citing concrete evidence from both responses>"}
\`\`\``;

function judgeFor(fusionFamilies: string[], base: string, bases: string[]): string {
  // A judge from a family that is neither the base under comparison nor (as far as the pool allows) the fusion's synthesizer.
  const candidates = bases.filter((b) => b !== base && !fusionFamilies.includes(b));
  return candidates[0] ?? bases.find((b) => b !== base) ?? base;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(args.out), { recursive: true });
  const base = process.env.KERNEL_BENCH_BASE ?? "http://127.0.0.1:9876/v1";
  const key = process.env.KERNEL_BENCH_KEY ?? "local-fusion-key";
  const opts = { baseUrl: base, apiKey: key, sessionPrefix: "kjudge", timeoutMs: 1_200_000 as number };

  const existing: Array<AnswerRow | JudgeRow> = existsSync(args.out)
    ? readFileSync(args.out, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as AnswerRow | JudgeRow)
    : [];
  const answers = new Map<string, AnswerRow>();
  for (const r of existing) if (r.type === "answer" && r.ok) answers.set(`${r.itemId}|${r.model}`, r);
  const judgments = new Set(existing.filter((r): r is JudgeRow => r.type === "judgment").map((r) => `${r.itemId}|${r.base}|${r.order}`));

  const items = loadCreativity(args.n);
  const models = [args.fusion, ...args.bases];

  // 1) Collect answers.
  const answerJobs = items.flatMap((item) => models.filter((m) => !answers.has(`${item.id}|${m}`)).map((model) => ({ item, model })));
  console.log(`judge: ${items.length} items; ${answerJobs.length} answers to collect`);
  let idx = 0;
  const answerWorker = async () => {
    for (;;) {
      const job = answerJobs[idx++];
      if (job === undefined) return;
      const res = await chatCall({ ...opts, stream: true }, job.model, job.item.messages, `${job.item.id}-${job.model}`.replace(/[^a-zA-Z0-9_.:-]/g, "_"));
      const row: AnswerRow = { type: "answer", itemId: job.item.id, model: job.model, content: res.content, latencyMs: res.latencyMs, ok: res.ok };
      appendFileSync(args.out, `${JSON.stringify(row)}\n`);
      if (res.ok) answers.set(`${job.item.id}|${job.model}`, row);
      console.log(`  answer ${res.ok ? "✓" : "!"} ${job.model.padEnd(22)} ${job.item.id.padEnd(24)} ${res.latencyMs}ms ${res.error ?? ""}`);
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, () => answerWorker()));

  // 2) Pairwise judgments, both orders.
  const fusionFamilies = ["glm-5.3"]; // fusion-max synthesizes with glm-5.3; avoid it as judge when possible
  const judgeJobs: Array<{ item: (typeof items)[number]; base: string; order: JudgeRow["order"] }> = [];
  for (const item of items) {
    const f = answers.get(`${item.id}|${args.fusion}`);
    if (f === undefined) continue;
    for (const b of args.bases) {
      if (answers.get(`${item.id}|${b}`) === undefined) continue;
      for (const order of ["fusion_first", "base_first"] as const) {
        if (!judgments.has(`${item.id}|${b}|${order}`)) judgeJobs.push({ item, base: b, order });
      }
    }
  }
  console.log(`judge: ${judgeJobs.length} judgments to run`);
  idx = 0;
  const judgeWorker = async () => {
    for (;;) {
      const job = judgeJobs[idx++];
      if (job === undefined) return;
      const f = answers.get(`${job.item.id}|${args.fusion}`)!;
      const b = answers.get(`${job.item.id}|${job.base}`)!;
      const [A, B] = job.order === "fusion_first" ? [f, b] : [b, f];
      const judge = judgeFor(fusionFamilies, job.base, args.bases);
      const user = `BRIEF:\n${job.item.messages[0]!.content}\n\n=== RESPONSE A ===\n${A.content}\n\n=== RESPONSE B ===\n${B.content}\n\nWhich response better fulfils the brief? Output the json block.`;
      const res = await chatCall({ ...opts, stream: true, reasoningEffort: "medium" }, judge, [{ role: "system", content: JUDGE_SYSTEM }, { role: "user", content: user }], `${job.item.id}-${job.base}-${job.order}`.replace(/[^a-zA-Z0-9_.:-]/g, "_"));
      const m = res.content.match(/"winner"\s*:\s*"(A|B|tie)"/i);
      const winner = (m?.[1]?.toUpperCase() === "A" ? "A" : m?.[1]?.toUpperCase() === "B" ? "B" : "tie") as JudgeRow["winner"];
      const rationale = res.content.match(/"rationale"\s*:\s*"([\s\S]*?)"\s*\}/)?.[1]?.slice(0, 600) ?? res.error ?? "";
      const row: JudgeRow = { type: "judgment", itemId: job.item.id, fusion: args.fusion, base: job.base, judge, order: job.order, winner, rationale };
      appendFileSync(args.out, `${JSON.stringify(row)}\n`);
      console.log(`  judged ${job.item.id.padEnd(24)} vs ${job.base.padEnd(22)} [${job.order}] by ${judge}: ${winner}`);
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, () => judgeWorker()));

  // 3) Report: a fusion win requires winning both orders; loss requires losing both; else tie.
  const all: Array<AnswerRow | JudgeRow> = readFileSync(args.out, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as AnswerRow | JudgeRow);
  const byPair = new Map<string, Partial<Record<JudgeRow["order"], JudgeRow["winner"]>>>();
  for (const r of all) {
    if (r.type !== "judgment") continue;
    const k = `${r.itemId}|${r.base}`;
    const e = byPair.get(k) ?? {};
    e[r.order] = r.winner;
    byPair.set(k, e);
  }
  const tally = new Map<string, { win: number; tie: number; loss: number }>();
  for (const [k, e] of byPair) {
    const baseName = k.split("|")[1]!;
    const t = tally.get(baseName) ?? { win: 0, tie: 0, loss: 0 };
    const fusionWonFirst = e.fusion_first === "A";
    const fusionWonSecond = e.base_first === "B";
    const fusionLostFirst = e.fusion_first === "B";
    const fusionLostSecond = e.base_first === "A";
    if (fusionWonFirst && fusionWonSecond) t.win += 1;
    else if (fusionLostFirst && fusionLostSecond) t.loss += 1;
    else t.tie += 1;
    tally.set(baseName, t);
  }
  const lines = [`creative pairwise (fusion=${args.fusion}; win requires both presentation orders):`];
  for (const [b, t] of tally) lines.push(`  vs ${b.padEnd(22)} win ${t.win}  tie ${t.tie}  loss ${t.loss}`);
  const text = lines.join("\n");
  console.log(text);
  if (args.report !== undefined) writeFileSync(args.report, `${text}\n`, "utf8");
}

await main();
