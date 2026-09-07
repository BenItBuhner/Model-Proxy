/**
 * SWE-bench Verified without Docker: a local harness that
 *   1. picks a deterministic sample of instances from pure-Python repos whose
 *      swebench spec runs on a uv-installable Python (>= 3.8),
 *   2. materialises the repo at base_commit with a per-run uv venv and the
 *      official install recipe (swebench==4.x specs via swe_helper.py),
 *   3. lets the model under test work the issue through OpenAI tool calling
 *      (bash / str_replace / write_file / submit) against the proxy — for
 *      fusion-max this is the kernel's tool-continuation path,
 *   4. evaluates the resulting diff exactly like the official harness: reset
 *      test files, apply test_patch, run the spec's test command on the test
 *      directives, parse with the repo's log parser, RESOLVED_FULL or not.
 *
 * Rows are appended to a JSONL store compatible with kernel-bench/report.ts
 * (suite "swebench-verified", kind "code", correct = resolved).
 *
 *   KERNEL_BENCH_BASE=http://127.0.0.1:9877/v1 bun run benchmarks/kernel-bench/swe/run.ts \
 *     --models fusion-max --label fusion-max@v47 --n 12 --out /tmp/kernel-bench/results-swe.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RUN_VERSION, type ModelRun } from "../types.ts";

const BASE = process.env.KERNEL_BENCH_BASE ?? "http://127.0.0.1:9876/v1";
const API_KEY = process.env.KERNEL_BENCH_KEY ?? "local-fusion-key";
const ROOT = process.env.KERNEL_BENCH_SWE_ROOT ?? "/tmp/kernel-bench/swe";
const HELPER_PY = process.env.KERNEL_BENCH_SWE_PYTHON ?? "/tmp/swe-venv/bin/python";
const HELPER = new URL("./swe_helper.py", import.meta.url).pathname;
const ALLOWED_REPOS = new Set(["django/django", "sympy/sympy", "pytest-dev/pytest", "pylint-dev/pylint", "psf/requests", "pallets/flask"]);

interface Instance {
  repo: string;
  instance_id: string;
  base_commit: string;
  patch: string;
  test_patch: string;
  problem_statement: string;
  hints_text: string;
  version: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
  environment_setup_commit: string;
  difficulty?: string;
}

interface Spec {
  python: string;
  pre_install: string[];
  install: string;
  pip_packages: string[];
  packages: string;
  requirements: string | null;
  test_cmd: string;
  directives: string[];
  start: string;
  end: string;
}

interface Args { models: string[]; label?: string; n: number; out: string; only?: Set<string>; maxSteps: number; wallMs: number; concurrency: number; effort?: string; gold: boolean }

function parseArgs(argv: string[]): Args {
  const args: Args = { models: ["fusion-max"], n: 12, out: join(ROOT, "results-swe.jsonl"), maxSteps: 40, wallMs: 45 * 60_000, concurrency: 1, gold: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = argv[i + 1];
    switch (a) {
      case "--models": args.models = String(v).split(",").map((s) => s.trim()).filter(Boolean); i++; break;
      case "--label": args.label = v; i++; break;
      case "--n": args.n = Number(v); i++; break;
      case "--out": args.out = String(v); i++; break;
      case "--only": args.only = new Set(String(v).split(",").map((s) => s.trim())); i++; break;
      case "--max-steps": args.maxSteps = Number(v); i++; break;
      case "--wall-minutes": args.wallMs = Number(v) * 60_000; i++; break;
      case "--concurrency": args.concurrency = Number(v); i++; break;
      case "--effort": args.effort = v; i++; break;
      case "--gold": args.gold = true; break; // apply the reference patch instead of running an agent (harness validation)
      default: break;
    }
  }
  return args;
}

// ── instances ─────────────────────────────────────────────────────────

async function loadVerified(): Promise<Instance[]> {
  mkdirSync(ROOT, { recursive: true });
  const cache = join(ROOT, "swe-verified.json");
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, "utf8")) as Instance[];
  const rows: Instance[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const res = await fetch(`https://datasets-server.huggingface.co/rows?dataset=princeton-nlp/SWE-bench_Verified&config=default&split=test&offset=${offset}&length=100`, { signal: AbortSignal.timeout(90_000) });
    if (!res.ok) throw new Error(`HF rows ${offset}: ${res.status}`);
    const body = (await res.json()) as { rows: Array<{ row: Instance }> };
    rows.push(...body.rows.map((r) => r.row));
  }
  writeFileSync(cache, JSON.stringify(rows), "utf8");
  return rows;
}

function sample<T>(rows: T[], n: number, seed: string): T[] {
  const scored = rows.map((row, index) => ({ row, key: createHash("sha256").update(`${seed}:${index}`).digest("hex") }));
  scored.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return scored.slice(0, n).map((s) => s.row);
}

// ── shell helpers ─────────────────────────────────────────────────────

interface ShellResult { code: number; out: string; timedOut: boolean; durationMs: number }

async function sh(command: string, opts: { cwd: string; env?: Record<string, string>; timeoutMs: number; maxChars?: number }): Promise<ShellResult> {
  const started = performance.now();
  const proc = Bun.spawn(["bash", "-lc", command], { cwd: opts.cwd, env: { ...process.env, ...(opts.env ?? {}) }, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; try { proc.kill("SIGKILL"); } catch { /* gone */ } }, opts.timeoutMs);
  const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  clearTimeout(timer);
  const raw = stdout + (stderr.length > 0 ? `\n${stderr}` : "");
  const max = opts.maxChars ?? 12_000;
  const out = raw.length > max ? `${raw.slice(0, max / 2)}\n... [${raw.length - max} chars omitted] ...\n${raw.slice(-max / 2)}` : raw;
  return { code, out, timedOut, durationMs: Math.round(performance.now() - started) };
}

async function helper(command: "spec" | "grade", instancePath: string, logPath?: string): Promise<Record<string, unknown>> {
  const argv = [HELPER_PY, HELPER, command, "--instance", instancePath, ...(logPath !== undefined ? ["--log", logPath] : [])];
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  if (code !== 0) throw new Error(`swe_helper ${command} failed (${code}): ${err.slice(-800)}`);
  return JSON.parse(out.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
}

// ── environment ───────────────────────────────────────────────────────

interface Workspace { dir: string; venv: string; python: string; env: Record<string, string>; spec: Spec; instancePath: string }

async function prepareWorkspace(inst: Instance, modelSlug: string, log: (s: string) => void): Promise<Workspace> {
  const repoSlug = inst.repo.replace("/", "__");
  const bare = join(ROOT, "repos", `${repoSlug}.git`);
  mkdirSync(join(ROOT, "repos"), { recursive: true });
  if (!existsSync(bare)) {
    log(`cloning ${inst.repo}`);
    const r = await sh(`git clone --bare --quiet https://github.com/${inst.repo}.git ${bare}`, { cwd: ROOT, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error(`clone failed: ${r.out.slice(-500)}`);
  } else {
    await sh(`git --git-dir=${bare} fetch --quiet origin '+refs/heads/*:refs/heads/*' || true`, { cwd: ROOT, timeoutMs: 10 * 60_000 });
  }
  const dir = join(ROOT, "work", inst.instance_id, modelSlug);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const co = await sh(`git clone --quiet ${bare} repo && cd repo && git checkout --quiet ${inst.base_commit} && git config user.email bench@example.com && git config user.name bench`, { cwd: dir, timeoutMs: 10 * 60_000 });
  if (co.code !== 0) throw new Error(`checkout failed: ${co.out.slice(-500)}`);
  const repoDir = join(dir, "repo");
  const instancePath = join(dir, "instance.json");
  writeFileSync(instancePath, JSON.stringify(inst), "utf8");
  const spec = (await helper("spec", instancePath)) as unknown as Spec;
  const venv = join(dir, ".venv");
  const mk = await sh(`uv venv --seed --quiet --python ${spec.python} ${venv}`, { cwd: dir, timeoutMs: 10 * 60_000 });
  if (mk.code !== 0) throw new Error(`venv failed: ${mk.out.slice(-500)}`);
  const python = join(venv, "bin", "python");
  const env = { PATH: `${join(venv, "bin")}:${process.env.PATH ?? ""}`, VIRTUAL_ENV: venv, PIP_DISABLE_PIP_VERSION_CHECK: "1", PYTHONDONTWRITEBYTECODE: "1", GIT_TERMINAL_PROMPT: "0" };
  const pipInstall = async (what: string) => {
    const r = await sh(`uv pip install --quiet --python ${python} ${what}`, { cwd: repoDir, env, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) log(`pip install ${what.slice(0, 60)} failed: ${r.out.slice(-300)}`);
  };
  for (const cmd of spec.pre_install) {
    const r = await sh(cmd, { cwd: repoDir, env, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) log(`pre_install failed: ${cmd} → ${r.out.slice(-300)}`);
  }
  if (spec.requirements !== null && spec.requirements.trim().length > 0) {
    const reqPath = join(dir, "requirements.txt");
    // Drop packages that need system services or native builds the sandbox lacks.
    const cleaned = spec.requirements.split("\n").filter((l) => !/^(pylibmc|pymemcache|redis|selenium|geoip2|aiosmtpd|pywatchman|argon2-cffi|bcrypt|black|numpy|Pillow|jinja2|docutils)\b/i.test(l.trim())).join("\n");
    writeFileSync(reqPath, cleaned, "utf8");
    await pipInstall(`-r ${reqPath}`);
  } else if (spec.packages && spec.packages !== "requirements.txt" && spec.packages !== "environment.yml") {
    await pipInstall(spec.packages);
  }
  if (spec.pip_packages.length > 0) await pipInstall(spec.pip_packages.map((p) => `'${p}'`).join(" "));
  if (spec.install) {
    const install = spec.install.replace(/(?:python -m )?pip install/g, `uv pip install --python ${python}`);
    const r = await sh(install, { cwd: repoDir, env, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) log(`install failed: ${r.out.slice(-400)}`);
  }
  await sh("git add -A && git commit --quiet -m 'bench: environment' --allow-empty || true", { cwd: repoDir, env, timeoutMs: 60_000 });
  return { dir, venv, python, env, spec, instancePath };
}

// ── agent loop ────────────────────────────────────────────────────────

const TOOLS = [
  { type: "function", function: { name: "bash", description: "Run a bash command in the repository root (the project's virtualenv is active). Output is truncated. Use it to explore (ls, grep -rn, sed -n), run the test suite, and inspect behaviour.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "str_replace", description: "Edit a file by replacing ONE exact occurrence of old_string with new_string. Fails if old_string is missing or not unique.", parameters: { type: "object", properties: { path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } }, required: ["path", "old_string", "new_string"] } } },
  { type: "function", function: { name: "write_file", description: "Create or overwrite a file with the given content.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "submit", description: "Finish: submit the current working-tree changes as the fix.", parameters: { type: "object", properties: { summary: { type: "string" } } } } },
];

const SYSTEM_PROMPT = `You are an expert software engineer fixing a GitHub issue in a real repository.
The repository is checked out at the working directory with its virtualenv active. Work autonomously with the tools:
- Reproduce or localise the problem first (grep for the relevant symbols, read the code, write a small script or run the existing tests).
- Make a minimal, correct source change that fixes the root cause. Do not edit or add tests unless needed to understand the behaviour; hidden tests will be run against your change.
- Verify with the project's own test runner where feasible, then call submit.
Be economical: avoid printing huge files; use sed -n 'A,Bp' and grep -n. Never use interactive commands. You have a limited number of steps.`;

interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>; tool_call_id?: string }

interface AgentOutcome { steps: number; submitted: boolean; toolCalls: number; assistantChars: number; error?: string; lastAssistant: string; latencyMs: number; modelCallMs: number }

async function chat(model: string, messages: ChatMessage[], extra: Record<string, unknown>, signal: AbortSignal): Promise<{ message: ChatMessage; ms: number }> {
  const started = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: "auto", stream: false, max_tokens: 16_000, reasoning_effort: "high", ...extra }),
    signal,
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const body = (await res.json()) as { choices: Array<{ message: ChatMessage }> };
  const message = body.choices[0]?.message;
  if (message === undefined) throw new Error("no choices");
  return { message, ms: Math.round(performance.now() - started) };
}

function applyStrReplace(path: string, oldStr: string, newStr: string): string {
  if (!existsSync(path)) return `ERROR: ${path} does not exist`;
  const text = readFileSync(path, "utf8");
  const first = text.indexOf(oldStr);
  if (first < 0) return "ERROR: old_string not found (must match exactly, including whitespace)";
  if (text.indexOf(oldStr, first + 1) >= 0) return "ERROR: old_string is not unique; include more context";
  writeFileSync(path, text.slice(0, first) + newStr + text.slice(first + oldStr.length), "utf8");
  return `OK: replaced in ${path}`;
}

async function runAgent(model: string, inst: Instance, ws: Workspace, args: Args, log: (s: string) => void): Promise<AgentOutcome> {
  const repoDir = join(ws.dir, "repo");
  const started = performance.now();
  const deadline = started + args.wallMs;
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Repository: ${inst.repo} (version ${inst.version}). Fix the following issue; when done, call submit.\n\n<issue>\n${inst.problem_statement.trim()}\n</issue>` },
  ];
  const extra: Record<string, unknown> = args.effort !== undefined ? { fusion: { effort: args.effort } } : {};
  let steps = 0;
  let toolCalls = 0;
  let assistantChars = 0;
  let modelCallMs = 0;
  let lastAssistant = "";
  let submitted = false;
  let error: string | undefined;
  while (steps < args.maxSteps && performance.now() < deadline) {
    steps += 1;
    const remaining = Math.max(30_000, deadline - performance.now());
    let reply: ChatMessage;
    try {
      const r = await chat(model, messages, extra, AbortSignal.timeout(Math.min(remaining, 40 * 60_000)));
      reply = r.message;
      modelCallMs += r.ms;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log(`step ${steps} model error: ${error.slice(0, 200)}`);
      break;
    }
    assistantChars += (reply.content ?? "").length;
    lastAssistant = reply.content ?? lastAssistant;
    const calls = reply.tool_calls ?? [];
    messages.push({ role: "assistant", content: reply.content ?? "", ...(calls.length > 0 ? { tool_calls: calls } : {}) });
    if (calls.length === 0) {
      // No tool call: nudge once, then treat a second silent turn as done.
      if (messages.filter((m) => m.role === "user").length >= 3) break;
      messages.push({ role: "user", content: "Continue using the tools. When the fix is complete and verified, call submit." });
      continue;
    }
    for (const call of calls) {
      toolCalls += 1;
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; } catch { parsed = {}; }
      let result = "";
      if (call.function.name === "bash") {
        const r = await sh(`( ${String(parsed["command"] ?? "")} ) 2>&1`, { cwd: repoDir, env: ws.env, timeoutMs: 180_000, maxChars: 10_000 });
        result = `${r.out}${r.timedOut ? "\n[command timed out after 180 s]" : ""}\n[exit ${r.code}]`;
      } else if (call.function.name === "str_replace") {
        const p = String(parsed["path"] ?? "");
        result = applyStrReplace(p.startsWith("/") ? p : join(repoDir, p), String(parsed["old_string"] ?? ""), String(parsed["new_string"] ?? ""));
      } else if (call.function.name === "write_file") {
        const p = String(parsed["path"] ?? "");
        const full = p.startsWith("/") ? p : join(repoDir, p);
        mkdirSync(join(full, ".."), { recursive: true });
        writeFileSync(full, String(parsed["content"] ?? ""), "utf8");
        result = `OK: wrote ${p}`;
      } else if (call.function.name === "submit") {
        submitted = true;
        result = "Submitted.";
      } else {
        result = `ERROR: unknown tool ${call.function.name}`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
    if (submitted) break;
  }
  return { steps, submitted, toolCalls, assistantChars, error, lastAssistant, latencyMs: Math.round(performance.now() - started), modelCallMs };
}

// ── evaluation ────────────────────────────────────────────────────────

interface EvalOutcome { resolved: boolean; status: string; patchChars: number; f2p?: { success: number; failure: number }; p2p?: { success: number; failure: number }; detail?: string }

async function evaluate(inst: Instance, ws: Workspace, log: (s: string) => void): Promise<EvalOutcome> {
  const repoDir = join(ws.dir, "repo");
  // Model patch = everything changed since the environment commit, excluding untracked junk outside source.
  const diff = await sh("git add -A && git diff --cached --binary HEAD", { cwd: repoDir, env: ws.env, timeoutMs: 60_000, maxChars: 5_000_000 });
  const patch = diff.out.replace(/\n\[exit \d+\]$/, "");
  writeFileSync(join(ws.dir, "model.patch"), patch, "utf8");
  await sh("git reset --quiet", { cwd: repoDir, env: ws.env, timeoutMs: 60_000 });
  if (patch.trim().length === 0) return { resolved: false, status: "EMPTY_PATCH", patchChars: 0 };
  // Reset the test files touched by the official test patch to base, then apply it.
  const testFiles = [...inst.test_patch.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);
  const testPatchPath = join(ws.dir, "test.patch");
  writeFileSync(testPatchPath, inst.test_patch, "utf8");
  const reset = await sh(`git checkout ${inst.base_commit} -- ${testFiles.map((f) => `'${f}'`).join(" ")} 2>/dev/null; git apply -v ${testPatchPath}`, { cwd: repoDir, env: ws.env, timeoutMs: 60_000 });
  if (reset.code !== 0) {
    log(`test patch apply failed: ${reset.out.slice(-300)}`);
    return { resolved: false, status: "TEST_PATCH_FAILED", patchChars: patch.length, detail: reset.out.slice(-300) };
  }
  const cmd = `${ws.spec.test_cmd} ${ws.spec.directives.map((d) => `'${d}'`).join(" ")}`;
  const logPath = join(ws.dir, "eval.log");
  // Merge stderr into stdout in order: several runners (django) report on stderr.
  const run = await sh(`( echo '${ws.spec.start}'; ${cmd}; echo '${ws.spec.end}' ) 2>&1`, { cwd: repoDir, env: ws.env, timeoutMs: 30 * 60_000, maxChars: 20_000_000 });
  writeFileSync(logPath, run.out, "utf8");
  if (run.timedOut) return { resolved: false, status: "TESTS_TIMEOUT", patchChars: patch.length };
  const graded = await helper("grade", ws.instancePath, logPath);
  return {
    resolved: graded["resolved"] === true,
    status: String(graded["status"] ?? "?"),
    patchChars: patch.length,
    f2p: graded["f2p"] as { success: number; failure: number } | undefined,
    p2p: graded["p2p"] as { success: number; failure: number } | undefined,
  };
}

// ── main ──────────────────────────────────────────────────────────────

function loadDone(out: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(out)) return done;
  for (const line of readFileSync(out, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const row = JSON.parse(line) as ModelRun; if (row.ok) done.add(`${row.itemId}|${row.model}`); } catch { /* skip */ }
  }
  return done;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const all = await loadVerified();
  const eligible = all.filter((i) => ALLOWED_REPOS.has(i.repo));
  const specPython = (i: Instance): string | undefined => {
    // Cheap pre-filter from the known spec table: django < 4.0 runs on 3.6/3.5, which uv cannot install.
    if (i.repo === "django/django") return Number(i.version) >= 4.0 ? "ok" : undefined;
    return "ok";
  };
  const pool = eligible.filter((i) => specPython(i) !== undefined);
  let picked = sample(pool, args.n, "swebench-verified");
  if (args.only !== undefined) picked = pool.filter((i) => args.only!.has(i.instance_id));
  const done = loadDone(args.out);
  mkdirSync(join(args.out, ".."), { recursive: true });
  const queue: Array<{ inst: Instance; model: string }> = [];
  for (const inst of picked) for (const model of args.models) if (!done.has(`swebench-verified:${inst.instance_id}|${args.label ?? model}`)) queue.push({ inst, model });
  console.log(`swe-bench verified (local): ${picked.length} instances × ${args.models.length} models → ${queue.length} runs pending (${done.size} done) → ${args.out}`);
  let idx = 0;
  const worker = async () => {
    while (idx < queue.length) {
      const job = queue[idx++]!;
      const label = args.label ?? job.model;
      const tag = `${job.inst.instance_id} [${label}]`;
      const log = (s: string) => console.log(`  ${tag}: ${s}`);
      const started = performance.now();
      let row: ModelRun;
      try {
        const ws = await prepareWorkspace(job.inst, label.replace(/[^A-Za-z0-9_.-]/g, "_"), log);
        log(`env ready (python ${ws.spec.python}, ${ws.spec.directives.length} test directives)`);
        const agent = args.gold
          ? await (async (): Promise<AgentOutcome> => {
              writeFileSync(join(ws.dir, "gold.patch"), job.inst.patch, "utf8");
              const r = await sh(`git apply -v ${join(ws.dir, "gold.patch")}`, { cwd: join(ws.dir, "repo"), env: ws.env, timeoutMs: 60_000 });
              return { steps: 0, submitted: r.code === 0, toolCalls: 0, assistantChars: 0, error: r.code === 0 ? undefined : `gold patch failed: ${r.out.slice(-200)}`, lastAssistant: "gold", latencyMs: 0, modelCallMs: 0 };
            })()
          : await runAgent(job.model, job.inst, ws, args, log);
        log(`agent done: steps=${agent.steps} toolCalls=${agent.toolCalls} submitted=${agent.submitted} ${agent.error ? `error=${agent.error.slice(0, 80)}` : ""}`);
        const ev = await evaluate(job.inst, ws, log);
        row = {
          version: RUN_VERSION,
          at: new Date().toISOString(),
          suite: "swebench-verified",
          domain: "swe",
          itemId: `swebench-verified:${job.inst.instance_id}`,
          kind: "code",
          model: label,
          ok: agent.error === undefined || agent.steps > 1 || args.gold,
          content: agent.lastAssistant.slice(0, 4_000),
          predicted: ev.status,
          expected: "RESOLVED_FULL",
          correct: ev.resolved,
          latencyMs: Math.round(performance.now() - started),
          error: agent.error,
          kernel: { repo: job.inst.repo, version: job.inst.version, difficulty: job.inst.difficulty, steps: agent.steps, toolCalls: agent.toolCalls, submitted: agent.submitted, modelCallMs: agent.modelCallMs, agentMs: agent.latencyMs, patchChars: ev.patchChars, f2p: ev.f2p, p2p: ev.p2p, status: ev.status },
        };
        console.log(`[${idx}/${queue.length}] ${ev.resolved ? "✓" : "✗"} ${label.padEnd(22)} ${job.inst.instance_id.padEnd(32)} ${String(row.latencyMs).padStart(8)}ms  ${ev.status} steps=${agent.steps} f2p=${ev.f2p ? `${ev.f2p.success}/${ev.f2p.success + ev.f2p.failure}` : "-"} p2p=${ev.p2p ? `${ev.p2p.success}/${ev.p2p.success + ev.p2p.failure}` : "-"}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        row = { version: RUN_VERSION, at: new Date().toISOString(), suite: "swebench-verified", domain: "swe", itemId: `swebench-verified:${job.inst.instance_id}`, kind: "code", model: label, ok: false, content: "", latencyMs: Math.round(performance.now() - started), error: message, kernel: { repo: job.inst.repo, version: job.inst.version } };
        console.log(`[${idx}/${queue.length}] ! ${label.padEnd(22)} ${job.inst.instance_id.padEnd(32)} ${message.slice(0, 160)}`);
      }
      appendFileSync(args.out, `${JSON.stringify(row)}\n`, "utf8");
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, () => worker()));
}

await main();
