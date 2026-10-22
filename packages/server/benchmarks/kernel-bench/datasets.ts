import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { BenchItem, Domain } from "./types.ts";

/**
 * Public dataset loaders over the Hugging Face datasets-server API with a
 * local cache. Every suite yields BenchItems whose prompts are identical for
 * every model under test; graders live in graders.ts.
 */

const HF = "https://datasets-server.huggingface.co";
const CACHE_DIR = process.env.KERNEL_BENCH_CACHE ?? "/tmp/kernel-bench/cache";

const NUMERIC_INSTRUCTION =
  "Solve the problem. Reason carefully but concisely, then end your response with one final line of the exact form `FINAL: <answer>` where <answer> is only the final answer (a number, or a simplified expression in LaTeX). Do not put anything after that line.";
const MC_INSTRUCTION =
  "Choose the single best option. Reason concisely, then end your response with one final line of the exact form `FINAL: <letter>` containing only the option letter. Do not put anything after that line.";
const YESNO_INSTRUCTION =
  "Answer Yes or No. Reason concisely, then end your response with one final line of the exact form `FINAL: Yes` or `FINAL: No`. Do not put anything after that line.";
const CODE_INSTRUCTION =
  "Implement the function described below. Return the COMPLETE implementation (including the function signature and any imports it needs) inside a single ```python code block. Do not include tests, prints, or explanations outside the code block.";

interface HfRow {
  row_idx: number;
  row: Record<string, unknown>;
}

async function hfRows(params: { dataset: string; config: string; split: string; where?: string; length: number; offset?: number }): Promise<HfRow[]> {
  const key = createHash("sha256").update(JSON.stringify(params)).digest("hex").slice(0, 24);
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${key}.json`);
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as HfRow[];
  const endpoint = params.where !== undefined ? "filter" : "rows";
  const url = new URL(`${HF}/${endpoint}`);
  url.searchParams.set("dataset", params.dataset);
  url.searchParams.set("config", params.config);
  url.searchParams.set("split", params.split);
  if (params.where !== undefined) url.searchParams.set("where", params.where);
  url.searchParams.set("offset", String(params.offset ?? 0));
  url.searchParams.set("length", String(Math.min(100, params.length)));
  // Large filtered datasets return transient 500s while the server builds its index.
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
    if (res.ok) {
      const body = (await res.json()) as { rows: HfRow[] };
      writeFileSync(cachePath, JSON.stringify(body.rows), "utf8");
      return body.rows;
    }
    lastError = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status < 500) break;
    await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
  }
  throw new Error(`HF ${endpoint} ${params.dataset}/${params.config} failed: ${lastError}`);
}

/** Fetch a raw URL (GitHub raw, etc.) as text with the same local cache. */
async function cachedText(url: string): Promise<string> {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 24);
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${key}.txt`);
  if (existsSync(cachePath)) return readFileSync(cachePath, "utf8");
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const text = await res.text();
  writeFileSync(cachePath, text, "utf8");
  return text;
}

/** Deterministic sample of `n` rows (seeded shuffle) so reruns and models see the same items. */
function sample<T>(rows: T[], n: number, seed: string): T[] {
  const scored = rows.map((row, index) => ({ row, key: createHash("sha256").update(`${seed}:${index}`).digest("hex") }));
  scored.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return scored.slice(0, n).map((s) => s.row);
}

function item(args: {
  suite: string;
  index: number | string;
  domain: Domain;
  kind: BenchItem["kind"];
  user: string;
  answer?: string;
  code?: BenchItem["code"];
  meta?: Record<string, unknown>;
}): BenchItem {
  return {
    id: `${args.suite}:${args.index}`,
    suite: args.suite,
    domain: args.domain,
    kind: args.kind,
    messages: [{ role: "user", content: args.user }],
    answer: args.answer,
    code: args.code,
    meta: args.meta,
  };
}

// ── Math ──────────────────────────────────────────────────────────────

export async function loadMath500(n: number, opts: { minLevel?: number } = {}): Promise<BenchItem[]> {
  const minLevel = opts.minLevel ?? 5;
  const rows = await hfRows({ dataset: "HuggingFaceH4/MATH-500", config: "default", split: "test", where: `"level">=${minLevel}`, length: 100 });
  return sample(rows, n, "math500").map((r) =>
    item({
      suite: "math500",
      index: r.row_idx,
      domain: "math",
      kind: "numeric",
      user: `${String(r.row["problem"])}\n\n${NUMERIC_INSTRUCTION}`,
      answer: String(r.row["answer"]),
      meta: { subject: r.row["subject"], level: r.row["level"] },
    }),
  );
}

export async function loadAime2024(n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "Maxwell-Jia/AIME_2024", config: "default", split: "train", length: 30 });
  return sample(rows, n, "aime24").map((r) =>
    item({
      suite: "aime24",
      index: String(r.row["ID"] ?? r.row_idx),
      domain: "math",
      kind: "numeric",
      user: `${String(r.row["Problem"])}\n\n${NUMERIC_INSTRUCTION} (AIME answers are integers from 000 to 999.)`,
      answer: String(r.row["Answer"]),
    }),
  );
}

export async function loadAime2025(n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "MathArena/aime_2025", config: "default", split: "train", length: 30 });
  return sample(rows, n, "aime25").map((r) =>
    item({
      suite: "aime25",
      index: String(r.row["problem_idx"] ?? r.row_idx),
      domain: "math",
      kind: "numeric",
      user: `${String(r.row["problem"])}\n\n${NUMERIC_INSTRUCTION} (AIME answers are integers from 000 to 999.)`,
      answer: String(r.row["answer"]),
    }),
  );
}

/** MathArena competition sets (fresh, uncontaminated relative to older public sets). Answers may be LaTeX expressions. */
async function loadMathArena(suite: string, dataset: string, n: number, hint: string): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset, config: "default", split: "train", length: 100 });
  return sample(rows, n, suite).map((r) =>
    item({
      suite,
      index: String(r.row["problem_idx"] ?? r.row_idx),
      domain: "math",
      kind: "numeric",
      user: `${String(r.row["problem"])}\n\n${NUMERIC_INSTRUCTION}${hint}`,
      answer: String(r.row["answer"]),
      meta: { problem_type: r.row["problem_type"] },
    }),
  );
}

export const loadAime2026 = (n: number) => loadMathArena("aime26", "MathArena/aime_2026", n, " (AIME answers are integers from 000 to 999.)");
/** MathArena Apex: final-answer versions of the hardest 2025 olympiad problems; frontier models score far below ceiling. */
export const loadApex2025 = (n: number) => loadMathArena("apex25", "MathArena/apex_2025", n, "");

// ── ARC-AGI-2 public evaluation (exact grid match) ─────────────────────

const ARC_INSTRUCTION =
  "You are given training pairs that demonstrate a hidden transformation rule mapping an input grid to an output grid. Grids are 2D arrays of integers 0-9 (colors). Infer the rule from the training pairs and apply it to the test input. Think carefully: the output grid's dimensions may differ from the input's. End your response with the test output grid as a JSON array of arrays inside a ```json fenced block, and put nothing after that block.";

interface ArcTask { train: Array<{ input: number[][]; output: number[][] }>; test: Array<{ input: number[][]; output?: number[][] }> }

async function fetchJsonCached<T>(url: string): Promise<T> {
  const key = createHash("sha256").update(url).digest("hex").slice(0, 24);
  mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = join(CACHE_DIR, `${key}.json`);
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as T;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { "user-agent": "kernel-bench" } });
  if (!res.ok) throw new Error(`fetch ${url} failed: ${res.status}`);
  const text = await res.text();
  writeFileSync(cachePath, text, "utf8");
  return JSON.parse(text) as T;
}

const gridText = (g: number[][]) => `[${g.map((row) => `[${row.join(",")}]`).join(",\n ")}]`;

export async function loadArcAgi2(n: number): Promise<BenchItem[]> {
  const listing = await fetchJsonCached<Array<{ name: string; download_url: string }>>("https://api.github.com/repos/arcprize/ARC-AGI-2/contents/data/evaluation");
  const files = listing.filter((f) => f.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name));
  const picked = sample(files, n, "arcagi2");
  const items: BenchItem[] = [];
  for (const file of picked) {
    const task = await fetchJsonCached<ArcTask>(file.download_url);
    const test = task.test[0];
    if (test === undefined || test.output === undefined) continue;
    const trainText = task.train.map((p, i) => `Training pair ${i + 1}\nInput (${p.input.length}x${p.input[0]?.length ?? 0}):\n${gridText(p.input)}\nOutput (${p.output.length}x${p.output[0]?.length ?? 0}):\n${gridText(p.output)}`).join("\n\n");
    items.push({
      id: `arcagi2:${file.name.replace(".json", "")}`,
      suite: "arcagi2",
      domain: "reasoning",
      kind: "grid",
      messages: [{ role: "user", content: `${ARC_INSTRUCTION}\n\n${trainText}\n\nTest input (${test.input.length}x${test.input[0]?.length ?? 0}):\n${gridText(test.input)}` }],
      answer: JSON.stringify(test.output),
      meta: { trainPairs: task.train.length, testInputs: task.test.length },
    });
  }
  return items;
}
export const loadHmmtFeb2025 = (n: number) => loadMathArena("hmmt25", "MathArena/hmmt_feb_2025", n, "");
export const loadHmmtFeb2026 = (n: number) => loadMathArena("hmmt26", "MathArena/hmmt_feb_2026", n, "");
export const loadBrumo2025 = (n: number) => loadMathArena("brumo25", "MathArena/brumo_2025", n, "");

// ── SuperGPQA (graduate-level MC, hard difficulty, science fields) ───────

export async function loadSuperGpqa(field: "Physics" | "Chemistry" | "Biology", n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "m-a-p/SuperGPQA", config: "default", split: "train", where: `"difficulty"='hard' AND "field"='${field}'`, length: 100 });
  const suite = `supergpqa-${field.toLowerCase()}`;
  return sample(rows, n, suite).map((r) => {
    const options = (r.row["options"] as string[]) ?? [];
    const lettered = options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\n");
    return item({
      suite,
      index: String(r.row["uuid"] ?? r.row_idx).slice(0, 12),
      domain: "science",
      kind: "mc",
      user: `${String(r.row["question"])}\n\nOptions:\n${lettered}\n\n${MC_INSTRUCTION}`,
      answer: String(r.row["answer_letter"]),
      meta: { field, subfield: r.row["subfield"], difficulty: r.row["difficulty"] },
    });
  });
}

// ── MMLU-Pro (science / finance / legal / cs) ─────────────────────────

const MMLU_DOMAIN: Record<string, Domain> = {
  physics: "science",
  chemistry: "science",
  biology: "science",
  law: "legal",
  business: "finance",
  economics: "finance",
  "computer science": "swe",
  math: "math",
  engineering: "science",
  health: "science",
  psychology: "reasoning",
  philosophy: "reasoning",
  history: "reasoning",
  other: "reasoning",
};

export async function loadMmluPro(category: string, n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "TIGER-Lab/MMLU-Pro", config: "default", split: "test", where: `"category"='${category}'`, length: 100 });
  const suite = `mmlu-${category.replace(/\s+/g, "_")}`;
  return sample(rows, n, suite).map((r) => {
    const options = (r.row["options"] as string[]) ?? [];
    const lettered = options.map((opt, i) => `${String.fromCharCode(65 + i)}. ${opt}`).join("\n");
    return item({
      suite,
      index: String(r.row["question_id"] ?? r.row_idx),
      domain: MMLU_DOMAIN[category] ?? "reasoning",
      kind: "mc",
      user: `${String(r.row["question"])}\n\nOptions:\n${lettered}\n\n${MC_INSTRUCTION}`,
      answer: String(r.row["answer"]),
      meta: { category, src: r.row["src"] },
    });
  });
}

// ── SWE: HumanEval ────────────────────────────────────────────────────

export async function loadHumanEval(n: number): Promise<BenchItem[]> {
  const first = await hfRows({ dataset: "openai/openai_humaneval", config: "openai_humaneval", split: "test", length: 100, offset: 0 });
  const rest = await hfRows({ dataset: "openai/openai_humaneval", config: "openai_humaneval", split: "test", length: 100, offset: 100 });
  return sample([...first, ...rest], n, "humaneval").map((r) =>
    item({
      suite: "humaneval",
      index: String(r.row["task_id"] ?? r.row_idx).replace("/", "-"),
      domain: "swe",
      kind: "code",
      user: `${CODE_INSTRUCTION}\n\n\`\`\`python\n${String(r.row["prompt"])}\n\`\`\``,
      code: { prompt: String(r.row["prompt"]), test: String(r.row["test"]), entryPoint: String(r.row["entry_point"]) },
    }),
  );
}

// ── SWE: BigCodeBench-Hard (hidden unittest suites; frontier models ~35%) ──

/** Libraries that need network, native services or heavyweight installs; tasks using them are excluded. */
const BCB_EXCLUDED_LIBS = new Set([
  "tensorflow", "keras", "librosa", "soundfile", "geopandas", "shapely", "pytesseract", "cv2", "gensim", "flask_login", "flask_wtf", "wtforms", "flask_mail", "werkzeug",
  "smtplib", "ftplib", "socket", "ssl", "psutil", "requests", "urllib", "http", "select", "getpass", "docx", "Crypto", "cryptography", "rsa", "pyquery", "Levenshtein", "xlwt",
  "wordcloud", "nltk", "textblob", "statsmodels", "chardet", "flask", "cgi", "email", "subprocess", "threading", "queue", "sqlite3",
]);

const BCB_INSTRUCTION = "Solve the following programming task. Return the complete, self-contained solution (all imports plus the full function) as ONE ```python code block, and nothing after it.";

export async function loadBigCodeBenchHard(n: number): Promise<BenchItem[]> {
  const first = await hfRows({ dataset: "bigcode/bigcodebench-hard", config: "default", split: "v0.1.4", length: 100, offset: 0 });
  const rest = await hfRows({ dataset: "bigcode/bigcodebench-hard", config: "default", split: "v0.1.4", length: 100, offset: 100 });
  const parseLibs = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.map(String);
    try { return JSON.parse(String(v ?? "[]").replace(/'/g, "\"")) as string[]; } catch { return []; }
  };
  const eligible = [...first, ...rest].filter((r) => parseLibs(r.row["libs"]).every((l) => !BCB_EXCLUDED_LIBS.has(l)));
  return sample(eligible, n, "bcbhard").map((r) =>
    item({
      suite: "bcbhard",
      index: String(r.row["task_id"]).replace("BigCodeBench/", ""),
      domain: "swe",
      kind: "code",
      user: `${BCB_INSTRUCTION}\n\n${String(r.row["instruct_prompt"])}`,
      code: { prompt: String(r.row["code_prompt"]), test: String(r.row["test"]), entryPoint: String(r.row["entry_point"]), harness: "unittest" },
      meta: { libs: parseLibs(r.row["libs"]) },
    }),
  );
}

// ── Legal: LegalBench ─────────────────────────────────────────────────

export async function loadLegalBenchHearsay(n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "nguha/legalbench", config: "hearsay", split: "test", length: 100 });
  return sample(rows, n, "legalbench-hearsay").map((r) =>
    item({
      suite: "legalbench-hearsay",
      index: String(r.row["index"] ?? r.row_idx),
      domain: "legal",
      kind: "yesno",
      user: `Hearsay is an out-of-court statement introduced to prove the truth of the matter asserted. Consider the following fact pattern from a US evidence-law exercise and determine whether the described statement is hearsay.\n\nFact pattern: ${String(r.row["text"])}\n\n${YESNO_INSTRUCTION}`,
      answer: String(r.row["answer"]),
    }),
  );
}

export async function loadLegalBenchContractQa(n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "nguha/legalbench", config: "contract_qa", split: "test", length: 100 });
  return sample(rows, n, "legalbench-contract_qa").map((r) =>
    item({
      suite: "legalbench-contract_qa",
      index: String(r.row["index"] ?? r.row_idx),
      domain: "legal",
      kind: "yesno",
      user: `Read the contract clause and answer the question about it.\n\nClause: ${String(r.row["text"])}\n\nQuestion: ${String(r.row["question"])}\n\n${YESNO_INSTRUCTION}`,
      answer: String(r.row["answer"]),
    }),
  );
}

// ── Reasoning: BIG-Bench Extra Hard ──────────────────────────────────

const BBEH_TASKS = [
  "bbeh_boardgame_qa", "bbeh_boolean_expressions", "bbeh_buggy_tables", "bbeh_causal_understanding", "bbeh_disambiguation_qa",
  "bbeh_dyck_languages", "bbeh_geometric_shapes", "bbeh_hyperbaton", "bbeh_linguini", "bbeh_movie_recommendation",
  "bbeh_multistep_arithmetic", "bbeh_nycc", "bbeh_object_counting", "bbeh_object_properties", "bbeh_sarc_triples",
  "bbeh_shuffled_objects", "bbeh_spatial_reasoning", "bbeh_sportqa", "bbeh_temporal_sequence", "bbeh_time_arithmetic",
  "bbeh_web_of_lies", "bbeh_word_sorting", "bbeh_zebra_puzzles",
];
const EXACT_INSTRUCTION =
  "Reason carefully, then end your response with one final line of the exact form `FINAL: <answer>` where <answer> is only the answer in the format the task asks for (a number, a word, a letter option in parentheses such as (B), Yes/No, or a list) — nothing else on that line. Do not put anything after that line.";

/** BBEH: `perTask` examples from each of the 23 tasks (deterministic), graded by normalized exact match. */
export async function loadBbeh(n: number): Promise<BenchItem[]> {
  const perTask = Math.max(1, Math.round(n / BBEH_TASKS.length));
  const items: BenchItem[] = [];
  for (const task of BBEH_TASKS) {
    const raw = await cachedText(`https://raw.githubusercontent.com/google-deepmind/bbeh/main/bbeh/benchmark_tasks/${task}/task.json`);
    const examples = (JSON.parse(raw) as { examples: Array<{ input: string; target: string }> }).examples.map((e, i) => ({ ...e, i }));
    for (const e of sample(examples, perTask, `bbeh:${task}`)) {
      items.push(item({ suite: "bbeh", index: `${task.replace(/^bbeh_/, "")}-${e.i}`, domain: "reasoning", kind: "exact", user: `${e.input.trim()}\n\n${EXACT_INSTRUCTION}`, answer: e.target, meta: { task } }));
    }
  }
  return items.slice(0, Math.max(n, items.length));
}

// ── Finance: FinQA ───────────────────────────────────────────────────

interface FinQaRow { id: string; pre_text: string[]; post_text: string[]; table: string[][]; qa: { question: string; exe_ans: unknown; answer?: string } }

/** FinQA test set: numeric reasoning over 10-K text + table. Percent-form answers are accepted at either scale (see gradeItem). */
export async function loadFinQa(n: number): Promise<BenchItem[]> {
  const rows = JSON.parse(await cachedText("https://raw.githubusercontent.com/czyssrs/FinQA/main/dataset/test.json")) as FinQaRow[];
  const usable = rows.filter((r) => typeof r.qa?.exe_ans === "number" || (typeof r.qa?.exe_ans === "string" && /^-?[\d.]+$/.test(r.qa.exe_ans)));
  return sample(usable, n, "finqa").map((r) =>
    item({
      suite: "finqa",
      index: r.id.replace(/[^A-Za-z0-9_.-]/g, "_"),
      domain: "finance",
      kind: "numeric",
      user: [
        "You are given an excerpt from a company's annual report (text before the table, the table, text after the table) and a question. Compute the answer from the data given.",
        "",
        "TEXT BEFORE TABLE:", r.pre_text.join(" "),
        "",
        "TABLE:", r.table.map((row) => row.join(" | ")).join("\n"),
        "",
        "TEXT AFTER TABLE:", r.post_text.join(" "),
        "",
        `QUESTION: ${r.qa.question}`,
        "",
        "Answer with a single number. Percentages: give the percentage value (e.g. 12.5 for 12.5%), unless the question asks for a ratio or a decimal. Use the units the question implies (e.g. millions if the table is in millions). Reason concisely, then end with one final line of the exact form `FINAL: <number>` and nothing after it.",
      ].join("\n"),
      answer: String(r.qa.exe_ans),
      meta: { tolerance: 0.01, percentScale: true, question: r.qa.question },
    }),
  );
}

// ── Legal: LegalBench hard tasks ─────────────────────────────────────

/** SARA numeric: compute a taxpayer's liability from the statute text and a case description (exact dollar amount). */
export async function loadLegalBenchSaraNumeric(n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "nguha/legalbench", config: "sara_numeric", split: "test", length: 100 });
  return sample(rows, n, "legalbench-sara_numeric").map((r) =>
    item({
      suite: "legalbench-sara_numeric",
      index: String(r.row["index"] ?? r.row_idx),
      domain: "legal",
      kind: "numeric",
      user: `Apply the statute below to the facts and compute the exact amount asked for. Follow the statute's text literally (it is a simplified version of the US tax code); do not use outside knowledge of real tax rates.\n\nSTATUTE:\n${String(r.row["statute"]).replace(/<br>/g, "\n")}\n\nFACTS: ${String(r.row["description"])}\n\nQUESTION: ${String(r.row["question"])}\n\nReason step by step through the applicable sections, then end with one final line of the exact form \`FINAL: <amount>\` (a whole-dollar integer, no symbols) and nothing after it.`,
      answer: String(r.row["answer"]).replace(/[$,]/g, ""),
    }),
  );
}

/** SCALR: match a Supreme Court question to the correct holding (5-way MC). */
export async function loadLegalBenchScalr(n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "nguha/legalbench", config: "scalr", split: "test", length: 100 });
  const letters = ["A", "B", "C", "D", "E"];
  return sample(rows, n, "legalbench-scalr").map((r) =>
    item({
      suite: "legalbench-scalr",
      index: String(r.row["index"] ?? r.row_idx),
      domain: "legal",
      kind: "mc",
      user: `The question below was presented to the US Supreme Court. Which of the following holdings answers it?\n\nQUESTION PRESENTED: ${String(r.row["question"])}\n\n${letters.map((l, i) => `(${l}) ${String(r.row[`choice_${i}`])}`).join("\n\n")}\n\n${MC_INSTRUCTION}`,
      answer: letters[Number(r.row["answer"])] ?? "?",
    }),
  );
}

// ── Math beyond Apex: MathArena Apex shortlist ────────────────────────

/** MathArena Apex shortlist: the wider pool of 2025 olympiad problems the Apex set was drawn from. */
export async function loadApexShortlist(n: number): Promise<BenchItem[]> {
  const rows = await hfRows({ dataset: "MathArena/apex-shortlist", config: "default", split: "train", length: 100 });
  return sample(rows, n, "apex-shortlist").map((r) =>
    item({ suite: "apex-shortlist", index: String(r.row["problem_idx"]), domain: "math", kind: "numeric", user: `${String(r.row["problem"])}\n\n${NUMERIC_INSTRUCTION}`, answer: String(r.row["answer"]), meta: { source: r.row["source"] } }),
  );
}

// ── Creativity (open-ended; judged pairwise) ───────────────────────────

const CREATIVE_PROMPTS: Array<{ id: string; prompt: string }> = [
  { id: "flash-fiction", prompt: "Write a 300–400 word flash fiction piece told entirely through the voicemail messages one sibling leaves another over a single week. The reader should understand, without it being stated, that the callers' mother has died. End on an image, not a statement." },
  { id: "villanelle", prompt: "Write a villanelle (19 lines, ABA rhyme scheme with the two refrains in the correct positions) about a lighthouse keeper who has been automated out of a job. Keep the meter close to iambic pentameter and make the refrains shift meaning by the final quatrain." },
  { id: "product-copy", prompt: "Write landing-page copy (headline, subheadline, three benefit blocks with headers, and a closing call to action; under 220 words total) for a $12/month app that helps adults with ADHD start tasks. Be specific and concrete; avoid clichés like 'unlock your potential' and never mention 'game-changing'." },
  { id: "dialogue", prompt: "Write a two-character dialogue-only scene (no narration or stage directions, 350–450 words) in which a chess grandmaster and their eight-year-old student argue about whether it is ever right to resign. Each character must change the other's mind about something by the end, and neither may say the word 'lose'." },
  { id: "speech", prompt: "Write a 250-word toast for a retirement party for a school custodian of 34 years, delivered by a former student who is now a surgeon. It must include one specific, plausible anecdote, avoid sentimentality clichés, and land one genuinely funny line." },
  { id: "worldbuilding", prompt: "Invent a holiday celebrated in a floating city where gravity weakens for one hour each year. In about 350 words, describe its rituals, one food, one song lyric (4 lines), and a rule that children break. Make the details internally consistent and specific." },
];

export function loadCreativity(n: number): BenchItem[] {
  return CREATIVE_PROMPTS.slice(0, n).map((p) => ({
    id: `creative:${p.id}`,
    suite: "creative",
    domain: "creativity",
    kind: "open",
    messages: [{ role: "user", content: p.prompt }],
  }));
}

// ── Suite registry ────────────────────────────────────────────────────

export type SuiteName =
  | "math500"
  | "aime24"
  | "aime25"
  | "aime26"
  | "apex25"
  | "arcagi2"
  | "bcbhard"
  | "hmmt25"
  | "hmmt26"
  | "brumo25"
  | "supergpqa-physics"
  | "supergpqa-chemistry"
  | "supergpqa-biology"
  | "mmlu-physics"
  | "mmlu-chemistry"
  | "mmlu-biology"
  | "mmlu-law"
  | "mmlu-business"
  | "mmlu-economics"
  | "mmlu-computer_science"
  | "humaneval"
  | "legalbench-hearsay"
  | "legalbench-contract_qa"
  | "legalbench-sara_numeric"
  | "legalbench-scalr"
  | "bbeh"
  | "finqa"
  | "apex-shortlist"
  | "creative";

export const ALL_SUITES: SuiteName[] = [
  "math500", "aime24", "aime25", "aime26", "apex25", "hmmt25", "hmmt26", "brumo25", "arcagi2", "bcbhard",
  "supergpqa-physics", "supergpqa-chemistry", "supergpqa-biology",
  "mmlu-physics", "mmlu-chemistry", "mmlu-biology",
  "mmlu-law", "mmlu-business", "mmlu-economics", "mmlu-computer_science",
  "humaneval", "legalbench-hearsay", "legalbench-contract_qa", "legalbench-sara_numeric", "legalbench-scalr", "bbeh", "finqa", "apex-shortlist", "creative",
];

export async function loadSuite(name: SuiteName, n: number): Promise<BenchItem[]> {
  switch (name) {
    case "math500": return loadMath500(n);
    case "aime24": return loadAime2024(n);
    case "aime25": return loadAime2025(n);
    case "aime26": return loadAime2026(n);
    case "apex25": return loadApex2025(n);
    case "arcagi2": return loadArcAgi2(n);
    case "hmmt25": return loadHmmtFeb2025(n);
    case "hmmt26": return loadHmmtFeb2026(n);
    case "brumo25": return loadBrumo2025(n);
    case "supergpqa-physics": return loadSuperGpqa("Physics", n);
    case "supergpqa-chemistry": return loadSuperGpqa("Chemistry", n);
    case "supergpqa-biology": return loadSuperGpqa("Biology", n);
    case "mmlu-physics": return loadMmluPro("physics", n);
    case "mmlu-chemistry": return loadMmluPro("chemistry", n);
    case "mmlu-biology": return loadMmluPro("biology", n);
    case "mmlu-law": return loadMmluPro("law", n);
    case "mmlu-business": return loadMmluPro("business", n);
    case "mmlu-economics": return loadMmluPro("economics", n);
    case "mmlu-computer_science": return loadMmluPro("computer science", n);
    case "humaneval": return loadHumanEval(n);
    case "bcbhard": return loadBigCodeBenchHard(n);
    case "legalbench-hearsay": return loadLegalBenchHearsay(n);
    case "legalbench-contract_qa": return loadLegalBenchContractQa(n);
    case "legalbench-sara_numeric": return loadLegalBenchSaraNumeric(n);
    case "legalbench-scalr": return loadLegalBenchScalr(n);
    case "bbeh": return loadBbeh(n);
    case "finqa": return loadFinQa(n);
    case "apex-shortlist": return loadApexShortlist(n);
    case "creative": return loadCreativity(n);
  }
}
