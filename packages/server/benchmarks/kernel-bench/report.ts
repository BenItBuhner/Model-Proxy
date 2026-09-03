#!/usr/bin/env bun
/**
 * kernel-bench report: aggregates results.jsonl into per-model accuracy by
 * suite and domain, latency percentiles, and a head-to-head table of
 * fusion-max vs the best single base model. Writes a text table (stdout and
 * optional --out) plus a JSON summary (--json).
 *
 *   bun run benchmarks/kernel-bench/report.ts --in /tmp/kernel-bench/results.jsonl --out report.txt --json report.json
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gradeMc, gradeNumeric, gradeYesNo } from "./graders.ts";
import { RUN_VERSION, type ModelRun } from "./types.ts";

/** Re-grade text-answer rows from stored content so grader fixes apply retroactively (code rows keep their executed result). */
function regrade(row: ModelRun): ModelRun {
  if (!row.ok || row.expected === undefined || row.content.length === 0) return row;
  if (row.kind === "numeric") { const g = gradeNumeric(row.content, row.expected); return { ...row, predicted: g.predicted, correct: g.correct }; }
  if (row.kind === "mc") { const g = gradeMc(row.content, row.expected); return { ...row, predicted: g.predicted, correct: g.correct }; }
  if (row.kind === "yesno") { const g = gradeYesNo(row.content, row.expected); return { ...row, predicted: g.predicted, correct: g.correct }; }
  return row;
}

interface Args { in: string; out?: string; json?: string; fusion: string; alias: Map<string, string> }

function parseArgs(argv: string[]): Args {
  const args: Args = { in: "/tmp/kernel-bench/results.jsonl", fusion: "fusion-max", alias: new Map() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i] ?? "";
    if (a === "--in") args.in = next();
    else if (a === "--out") args.out = next();
    else if (a === "--json") args.json = next();
    else if (a === "--fusion") args.fusion = next();
    else if (a === "--alias") {
      // --alias fusion-max@v8=fusion-max,fusion-max@v9=fusion-max : merge labelled runs
      // into one model column (later files/rows win per item).
      for (const pair of next().split(",")) {
        const [from, to] = pair.split("=");
        if (from !== undefined && to !== undefined) args.alias.set(from.trim(), to.trim());
      }
    }
  }
  return args;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

interface Cell { n: number; correct: number; failed: number; latencies: number[] }

function cell(): Cell { return { n: 0, correct: 0, failed: 0, latencies: [] }; }

function acc(c: Cell): string {
  const graded = c.n - c.failed;
  return graded === 0 ? "   -   " : `${((c.correct / graded) * 100).toFixed(0).padStart(3)}% ${String(c.correct).padStart(2)}/${String(graded).padEnd(2)}`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const inputs = args.in.split(",").map((s) => s.trim()).filter(Boolean);
  const present = inputs.filter((p) => existsSync(p));
  if (present.length === 0) throw new Error(`no results at ${args.in}`);
  // Latest row per (item, model) wins (files are read in order, rows in append order).
  const latest = new Map<string, ModelRun>();
  for (const path of present) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      const parsed = JSON.parse(line) as ModelRun;
      if (parsed.version !== RUN_VERSION) continue;
      const row = args.alias.has(parsed.model) ? { ...parsed, model: args.alias.get(parsed.model)! } : parsed;
      latest.set(`${row.itemId}|${row.model}`, regrade(row));
    }
  }
  const rows = [...latest.values()].filter((r) => r.kind !== "open");
  const models = [...new Set(rows.map((r) => r.model))].sort((a, b) => (a === args.fusion ? 1 : b === args.fusion ? -1 : a.localeCompare(b)));
  const suites = [...new Set(rows.map((r) => r.suite))].sort();
  const domains = [...new Set(rows.map((r) => r.domain))].sort();

  // Only items every model attempted count toward comparisons.
  const itemsByModel = new Map<string, Set<string>>();
  for (const r of rows) {
    const set = itemsByModel.get(r.model) ?? new Set<string>();
    set.add(r.itemId);
    itemsByModel.set(r.model, set);
  }
  const common = new Set([...(itemsByModel.get(models[0] ?? "") ?? [])].filter((id) => models.every((m) => itemsByModel.get(m)?.has(id))));

  const bySuite = new Map<string, Map<string, Cell>>();
  const byDomain = new Map<string, Map<string, Cell>>();
  const overall = new Map<string, Cell>();
  for (const r of rows) {
    if (!common.has(r.itemId)) continue;
    for (const [table, key] of [[bySuite, r.suite], [byDomain, r.domain]] as Array<[Map<string, Map<string, Cell>>, string]>) {
      const m = table.get(key) ?? new Map<string, Cell>();
      const c = m.get(r.model) ?? cell();
      c.n += 1;
      if (!r.ok) c.failed += 1;
      else if (r.correct === true) c.correct += 1;
      c.latencies.push(r.latencyMs);
      m.set(r.model, c);
      table.set(key, m);
    }
    const o = overall.get(r.model) ?? cell();
    o.n += 1;
    if (!r.ok) o.failed += 1;
    else if (r.correct === true) o.correct += 1;
    o.latencies.push(r.latencyMs);
    overall.set(r.model, o);
  }

  const lines: string[] = [];
  lines.push(`kernel-bench report — ${rows.length} graded rows, ${common.size} items attempted by all ${models.length} models (${new Date().toISOString()})`);
  lines.push("");
  const header = `${"suite".padEnd(26)}${models.map((m) => m.padStart(18)).join("")}`;
  lines.push(header);
  lines.push("-".repeat(header.length));
  for (const suite of suites) {
    const m = bySuite.get(suite);
    if (m === undefined) continue;
    lines.push(`${suite.padEnd(26)}${models.map((model) => acc(m.get(model) ?? cell()).padStart(18)).join("")}`);
  }
  lines.push("");
  const dheader = `${"domain".padEnd(26)}${models.map((m) => m.padStart(18)).join("")}`;
  lines.push(dheader);
  lines.push("-".repeat(dheader.length));
  for (const domain of domains) {
    const m = byDomain.get(domain);
    if (m === undefined) continue;
    lines.push(`${domain.padEnd(26)}${models.map((model) => acc(m.get(model) ?? cell()).padStart(18)).join("")}`);
  }
  lines.push(`${"ALL".padEnd(26)}${models.map((model) => acc(overall.get(model) ?? cell()).padStart(18)).join("")}`);
  lines.push("");
  lines.push(`${"latency p50 / p90 (s)".padEnd(26)}${models.map((model) => { const c = overall.get(model) ?? cell(); return `${(percentile(c.latencies, 50) / 1000).toFixed(0)} / ${(percentile(c.latencies, 90) / 1000).toFixed(0)}`.padStart(18); }).join("")}`);
  lines.push(`${"failed calls".padEnd(26)}${models.map((model) => String((overall.get(model) ?? cell()).failed).padStart(18)).join("")}`);

  // Head-to-head: fusion vs best single base per domain.
  const bases = models.filter((m) => m !== args.fusion);
  if (models.includes(args.fusion) && bases.length > 0) {
    lines.push("");
    lines.push("fusion vs best single base model (same items):");
    for (const domain of [...domains, "ALL"]) {
      const m = domain === "ALL" ? overall : byDomain.get(domain);
      if (m === undefined) continue;
      const f = m.get(args.fusion);
      if (f === undefined) continue;
      const fAcc = f.n - f.failed === 0 ? 0 : f.correct / (f.n - f.failed);
      let bestBase = ""; let bestAcc = -1;
      for (const b of bases) {
        const c = m.get(b);
        if (c === undefined || c.n - c.failed === 0) continue;
        const a = c.correct / (c.n - c.failed);
        if (a > bestAcc) { bestAcc = a; bestBase = b; }
      }
      const delta = ((fAcc - Math.max(0, bestAcc)) * 100).toFixed(0);
      lines.push(`  ${domain.padEnd(12)} fusion ${(fAcc * 100).toFixed(0).padStart(3)}%  best base ${bestBase.padEnd(22)} ${(Math.max(0, bestAcc) * 100).toFixed(0).padStart(3)}%  Δ ${delta.padStart(4)} pts`);
    }
  }

  // Item-level disagreements where fusion was wrong (for failure analysis).
  const wrongFusion = rows.filter((r) => r.model === args.fusion && common.has(r.itemId) && r.ok && r.correct === false);
  if (wrongFusion.length > 0) {
    lines.push("");
    lines.push(`fusion misses (${wrongFusion.length}):`);
    for (const r of wrongFusion) {
      const others = bases.map((b) => { const o = latest.get(`${r.itemId}|${b}`); return `${b.split("-")[0]}=${o?.correct === true ? "✓" : o?.ok === false ? "!" : "✗"}`; }).join(" ");
      lines.push(`  ${r.itemId.padEnd(34)} pred=${String(r.predicted ?? "").slice(0, 20).padEnd(20)} exp=${String(r.expected ?? "").slice(0, 20).padEnd(20)} ${others}  agr=${String(r.kernel?.["agreement"] ?? "-")}`);
    }
  }

  const text = lines.join("\n");
  console.log(text);
  if (args.out !== undefined) writeFileSync(args.out, `${text}\n`, "utf8");
  if (args.json !== undefined) {
    const summary = {
      generatedAt: new Date().toISOString(),
      commonItems: common.size,
      models,
      bySuite: Object.fromEntries([...bySuite].map(([s, m]) => [s, Object.fromEntries([...m].map(([model, c]) => [model, { n: c.n, correct: c.correct, failed: c.failed, p50Ms: percentile(c.latencies, 50), p90Ms: percentile(c.latencies, 90) }]))])),
      byDomain: Object.fromEntries([...byDomain].map(([d, m]) => [d, Object.fromEntries([...m].map(([model, c]) => [model, { n: c.n, correct: c.correct, failed: c.failed, p50Ms: percentile(c.latencies, 50), p90Ms: percentile(c.latencies, 90) }]))])),
      overall: Object.fromEntries([...overall].map(([model, c]) => [model, { n: c.n, correct: c.correct, failed: c.failed, p50Ms: percentile(c.latencies, 50), p90Ms: percentile(c.latencies, 90) }])),
    };
    writeFileSync(args.json, JSON.stringify(summary, null, 2), "utf8");
  }
}

main();
