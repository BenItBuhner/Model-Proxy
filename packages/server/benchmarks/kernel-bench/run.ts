#!/usr/bin/env bun
/**
 * kernel-bench runner: evaluates models through the local proxy on public
 * benchmark suites and appends graded rows to a JSONL store (resumable —
 * already-completed (item, model, version) pairs are skipped).
 *
 * Usage:
 *   bun run benchmarks/kernel-bench/run.ts \
 *     --suites math500,aime24,mmlu-law,humaneval --n 6 \
 *     --models glm-5.3,kimi-k3,deepseek-v4-pro-0813,fusion-max \
 *     --concurrency 2 --out /tmp/kernel-bench/results.jsonl
 *
 * Env: KERNEL_BENCH_BASE (default http://127.0.0.1:9876/v1), KERNEL_BENCH_KEY (default local-fusion-key)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { chatCall } from "./client.ts";
import { ALL_SUITES, loadSuite, type SuiteName } from "./datasets.ts";
import { gradeItem } from "./graders.ts";
import { RUN_VERSION, type BenchItem, type ModelRun } from "./types.ts";

interface Args {
  suites: SuiteName[];
  n: number;
  models: string[];
  concurrency: number;
  out: string;
  effort: "low" | "medium" | "high" | undefined;
  maxTokens: number | undefined;
  timeoutMs: number;
  retryFailed: boolean;
  onlyItems: Set<string> | undefined;
  /** Row label override for a single model (e.g. fusion-max@v2) so before/after runs coexist. */
  label: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    suites: ["math500", "mmlu-law", "humaneval"],
    n: 4,
    models: ["glm-5.3", "kimi-k3", "deepseek-v4-pro-0813", "fusion-max"],
    concurrency: 2,
    out: "/tmp/kernel-bench/results.jsonl",
    effort: "high",
    maxTokens: undefined,
    timeoutMs: 1_800_000,
    retryFailed: false,
    onlyItems: undefined,
    label: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    switch (a) {
      case "--suites": {
        const list = next().split(",").map((s) => s.trim()).filter(Boolean);
        args.suites = list.includes("all") ? ALL_SUITES : (list as SuiteName[]);
        break;
      }
      case "--n": args.n = Number(next()); break;
      case "--models": args.models = next().split(",").map((s) => s.trim()).filter(Boolean); break;
      case "--concurrency": args.concurrency = Number(next()); break;
      case "--out": args.out = next(); break;
      case "--effort": { const e = next(); args.effort = e === "none" ? undefined : (e as Args["effort"]); break; }
      case "--max-tokens": args.maxTokens = Number(next()); break;
      case "--timeout-ms": args.timeoutMs = Number(next()); break;
      case "--retry-failed": args.retryFailed = true; break;
      case "--only": args.onlyItems = new Set(next().split(",").map((s) => s.trim()).filter(Boolean)); break;
      case "--label": args.label = next(); break;
      default: throw new Error(`unknown arg ${a}`);
    }
  }
  for (const s of args.suites) if (!ALL_SUITES.includes(s)) throw new Error(`unknown suite ${s}`);
  return args;
}

function loadDone(out: string, retryFailed: boolean): Set<string> {
  const done = new Set<string>();
  if (!existsSync(out)) return done;
  for (const line of readFileSync(out, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const row = JSON.parse(line) as ModelRun;
      if (row.version !== RUN_VERSION) continue;
      if (retryFailed && !row.ok) continue;
      done.add(`${row.itemId}|${row.model}`);
    } catch {
      // skip corrupt line
    }
  }
  return done;
}

async function runOne(item: BenchItem, model: string, args: Args): Promise<ModelRun> {
  const base = process.env.KERNEL_BENCH_BASE ?? "http://127.0.0.1:9876/v1";
  const key = process.env.KERNEL_BENCH_KEY ?? "local-fusion-key";
  const result = await chatCall(
    {
      baseUrl: base,
      apiKey: key,
      sessionPrefix: "kbench",
      timeoutMs: args.timeoutMs,
      reasoningEffort: args.effort,
      maxTokens: args.maxTokens,
      // Always stream: base models for origin timeouts, fusion for client idle
      // timeouts (the kernel appends its trace summary as a trailing SSE comment).
      stream: true,
    },
    model,
    item.messages,
    `${item.id}-${model}`.replace(/[^a-zA-Z0-9_.:-]/g, "_"),
  );
  const graded = result.ok ? await gradeItem(item, result.content) : {};
  return {
    itemId: item.id,
    suite: item.suite,
    domain: item.domain,
    kind: item.kind,
    model: args.label !== undefined && args.models.length === 1 ? args.label : model,
    ok: result.ok,
    predicted: graded.predicted,
    expected: graded.expected ?? item.answer,
    correct: graded.correct,
    latencyMs: result.latencyMs,
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    totalTokens: result.usage?.totalTokens,
    content: result.content.slice(0, 20_000),
    error: result.error ?? graded.detail,
    kernel: result.kernel,
    at: new Date().toISOString(),
    version: RUN_VERSION,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(dirname(args.out), { recursive: true });
  const done = loadDone(args.out, args.retryFailed);

  const items: BenchItem[] = [];
  for (const suite of args.suites) {
    const loaded = await loadSuite(suite, args.n);
    items.push(...loaded.filter((it) => args.onlyItems === undefined || args.onlyItems.has(it.id)));
  }
  const jobs: Array<{ item: BenchItem; model: string }> = [];
  for (const item of items) {
    if (item.kind === "open") continue; // open items are judged by judge.ts
    for (const model of args.models) {
      const rowModel = args.label !== undefined && args.models.length === 1 ? args.label : model;
      if (done.has(`${item.id}|${rowModel}`)) continue;
      jobs.push({ item, model });
    }
  }
  console.log(`kernel-bench: ${items.length} items × ${args.models.length} models → ${jobs.length} runs pending (${done.size} already done) → ${args.out}`);

  let index = 0;
  let completed = 0;
  const startedAt = Date.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[index++];
      if (job === undefined) return;
      const row = await runOne(job.item, job.model, args);
      appendFileSync(args.out, `${JSON.stringify(row)}\n`, "utf8");
      completed += 1;
      const mark = row.ok ? (row.correct === true ? "✓" : row.correct === false ? "✗" : "·") : "!";
      console.log(
        `[${completed}/${jobs.length}] ${mark} ${row.model.padEnd(22)} ${row.itemId.padEnd(34)} ${String(row.latencyMs).padStart(7)}ms` +
          (row.predicted !== undefined ? `  pred=${String(row.predicted).slice(0, 24)} exp=${String(row.expected ?? "").slice(0, 24)}` : "") +
          (row.error !== undefined ? `  err=${row.error.slice(0, 80).replace(/\n/g, " ")}` : "") +
          (row.kernel !== undefined
            ? `  kernel=${String(row.kernel["mode"])}/${String(row.kernel["band"])} waves=${String(row.kernel["waves"])} agr=${String(row.kernel["agreement"] ?? "-")} work=${String(row.kernel["cachedWorkItems"])}/${String(row.kernel["workItems"])}` +
              (row.kernel["vote"] !== undefined ? ` vote=${JSON.stringify((row.kernel["vote"] as Record<string, unknown>)["entries"])}` : "") +
              (row.kernel["settledAnswer"] !== undefined ? " settled" : "") +
              (Array.isArray(row.kernel["phases"]) ? ` phases=${(row.kernel["phases"] as string[]).join(",")}` : "")
            : ""),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));
  console.log(`done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

await main();
