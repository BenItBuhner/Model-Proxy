import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARC_UTILS_SOURCE } from "./arc-utils-source.ts";
import { deepEqualJson, type IoExample } from "./examples.ts";

/**
 * Sandboxed-ish execution of candidate Python programs against task
 * examples. A program is a fenced python block defining `solve(x)`; it is
 * run in an isolated interpreter (`python3 -I`) in a scratch directory with
 * CPU/memory limits and a wall-clock kill. This is an evaluation oracle for
 * tasks that ship ground-truth examples, not a general tool runtime: enable
 * `execution_verification` only on hosts where running model-written Python
 * is acceptable.
 */

export interface ExecutionFailure {
  index: number;
  expected: unknown;
  got: unknown;
  error?: string;
}

export interface ExecutionCheck {
  passed: number;
  total: number;
  failures: ExecutionFailure[];
  /** Program outputs on the task's test inputs (only when every example passed). */
  testOutputs: unknown[];
  error?: string;
  durationMs: number;
}

const HARNESS = `
import json, sys, os, resource
sys.path.insert(0, os.getcwd())
try:
    resource.setrlimit(resource.RLIMIT_AS, (1_500_000_000, 1_500_000_000))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
except Exception:
    pass
sys.setrecursionlimit(20000)
import candidate
with open("inputs.json") as f:
    payload = json.load(f)
results = []
for x in payload["inputs"]:
    try:
        out = candidate.solve(x)
        try:
            json.dumps(out)
        except Exception:
            out = json.loads(json.dumps(out, default=lambda o: list(o) if hasattr(o, "__iter__") else str(o)))
        results.append({"ok": True, "out": out})
    except Exception as e:
        results.append({"ok": False, "error": f"{type(e).__name__}: {e}"[:400]})
with open("outputs.json", "w") as f:
    json.dump(results, f)
`;

/** Extract the most plausible candidate program: the last fenced python block that defines solve(). */
export function extractSolveProgram(text: string): string | undefined {
  const blocks = [...text.matchAll(/```(?:python|py)\s*\n([\s\S]*?)```/gi)].map((m) => m[1] ?? "");
  const withSolve = blocks.filter((b) => /^\s*def\s+solve\s*\(/m.test(b));
  const pick = withSolve[withSolve.length - 1] ?? undefined;
  if (pick === undefined) return undefined;
  // Strip obvious harness lines a model may have added.
  return pick.replace(/^\s*if\s+__name__\s*==\s*["']__main__["']\s*:[\s\S]*$/m, "").trimEnd() + "\n";
}

export async function runSolveProgram(code: string, inputs: unknown[], timeoutMs = 10_000): Promise<{ results: Array<{ ok: boolean; out?: unknown; error?: string }>; error?: string }> {
  const dir = mkdtempSync(join(tmpdir(), "kernel-exec-"));
  try {
    writeFileSync(join(dir, "candidate.py"), code, "utf8");
    writeFileSync(join(dir, "arc_utils.py"), ARC_UTILS_SOURCE, "utf8");
    writeFileSync(join(dir, "harness.py"), HARNESS.replace(/CPU_SECONDS/g, String(Math.max(1, Math.ceil(timeoutMs / 1000)))), "utf8");
    writeFileSync(join(dir, "inputs.json"), JSON.stringify({ inputs }), "utf8");
    const proc = Bun.spawn([process.env.KERNEL_EXEC_PYTHON ?? "python3", "-I", "harness.py"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0" },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    if (exitCode !== 0) {
      return { results: [], error: (stderr.trim().split("\n").slice(-3).join(" | ") || `exit ${exitCode}`).slice(0, 500) };
    }
    const out = await Bun.file(join(dir, "outputs.json")).text();
    return { results: JSON.parse(out) as Array<{ ok: boolean; out?: unknown; error?: string }> };
  } catch (err) {
    return { results: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a candidate program on every example (and, when all pass, on the test inputs). */
export async function checkCandidateProgram(code: string, examples: IoExample[], tests: unknown[], timeoutMs = 10_000): Promise<ExecutionCheck> {
  const started = performance.now();
  const run = await runSolveProgram(code, [...examples.map((e) => e.input), ...tests], timeoutMs);
  const durationMs = Math.round(performance.now() - started);
  if (run.error !== undefined) {
    return { passed: 0, total: examples.length, failures: [{ index: 0, expected: examples[0]?.output, got: undefined, error: run.error }], testOutputs: [], error: run.error, durationMs };
  }
  const failures: ExecutionFailure[] = [];
  let passed = 0;
  examples.forEach((example, i) => {
    const r = run.results[i];
    if (r === undefined || !r.ok) failures.push({ index: i, expected: example.output, got: undefined, error: r?.error ?? "no result" });
    else if (deepEqualJson(r.out, example.output)) passed += 1;
    else failures.push({ index: i, expected: example.output, got: r.out });
  });
  const allPassed = passed === examples.length && examples.length > 0;
  const testOutputs = allPassed
    ? tests.map((_, i) => run.results[examples.length + i]).map((r) => (r !== undefined && r.ok ? r.out : undefined)).filter((v) => v !== undefined)
    : [];
  return { passed, total: examples.length, failures, testOutputs, durationMs };
}

// ── Code tasks: cross-execution of proposer-written tests ──────────────

const TESTS_MARKER = "# kernel-tests";

/** Solution block (first python block that is not the tests block) and tests block (`# kernel-tests`). */
export function extractSolutionAndTests(text: string): { solution?: string; tests?: string } {
  const blocks = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/gi)].map((m) => (m[1] ?? "").trim()).filter((b) => b.length > 0);
  const tests = blocks.find((b) => b.startsWith(TESTS_MARKER) || /^\s*#\s*kernel-tests/m.test(b.split("\n")[0] ?? ""));
  const candidates = blocks.filter((b) => b !== tests && /\b(def|class)\s+\w+/.test(b));
  const solution = candidates.sort((a, b) => b.length - a.length)[0];
  return { solution, tests };
}

const TEST_RUNNER = `
import json, sys, os, resource, traceback
sys.path.insert(0, os.getcwd())
try:
    resource.setrlimit(resource.RLIMIT_AS, (2_000_000_000, 2_000_000_000))
    resource.setrlimit(resource.RLIMIT_CPU, (CPU_SECONDS, CPU_SECONDS))
except Exception:
    pass
os.environ.setdefault("MPLBACKEND", "Agg")
result = {"import_error": None, "passed": [], "failed": {}}
try:
    import candidate
    ns = {k: getattr(candidate, k) for k in dir(candidate) if not k.startswith("__")}
    src = open("tests.py").read()
    exec(compile(src, "tests.py", "exec"), ns)
    names = [k for k, v in ns.items() if k.startswith("test") and callable(v)]
    names.sort()
    for name in names:
        try:
            ns[name]()
            result["passed"].append(name)
        except Exception as e:
            result["failed"][name] = f"{type(e).__name__}: {e}"[:300]
except Exception as e:
    result["import_error"] = f"{type(e).__name__}: {e}"[:400]
with open("result.json", "w") as f:
    json.dump(result, f)
`;

export interface TestRun { passed: string[]; failed: Record<string, string>; importError?: string; total: number }

/** Run one proposer's tests against one candidate solution; each `test*` function is an independent case. */
export async function runTestsAgainst(solution: string, tests: string, timeoutMs = 60_000): Promise<TestRun> {
  const dir = mkdtempSync(join(tmpdir(), "kernel-xtest-"));
  try {
    writeFileSync(join(dir, "candidate.py"), solution.endsWith("\n") ? solution : `${solution}\n`, "utf8");
    writeFileSync(join(dir, "tests.py"), tests.endsWith("\n") ? tests : `${tests}\n`, "utf8");
    writeFileSync(join(dir, "runner.py"), TEST_RUNNER.replace(/CPU_SECONDS/g, String(Math.max(2, Math.ceil(timeoutMs / 1000)))), "utf8");
    const python = process.env.KERNEL_EXEC_PYTHON ?? "python3";
    const proc = Bun.spawn([python, "-I", "runner.py"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", HOME: dir, MPLBACKEND: "Agg" },
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    const file = Bun.file(join(dir, "result.json"));
    if (!(await file.exists())) {
      return { passed: [], failed: {}, importError: (stderr.trim().split("\n").slice(-2).join(" | ") || `exit ${exitCode}`).slice(0, 400), total: 0 };
    }
    const parsed = JSON.parse(await file.text()) as { import_error: string | null; passed: string[]; failed: Record<string, string> };
    const total = parsed.passed.length + Object.keys(parsed.failed).length;
    return { passed: parsed.passed, failed: parsed.failed, importError: parsed.import_error ?? undefined, total };
  } catch (err) {
    return { passed: [], failed: {}, importError: err instanceof Error ? err.message : String(err), total: 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface CrossExecutionResult {
  /** Per solution index: tests passed / total tests across every test set. */
  scores: Array<{ passed: number; total: number; importErrors: number; failures: string[] }>;
  /** Number of usable test functions across all test sets. */
  totalTests: number;
}

/**
 * CodeT-style agreement: run every solution against every proposer's tests.
 * A solution's score is the number of test functions it passes across all
 * sets; tests that no solution passes are dropped as likely-wrong tests.
 */
export async function crossExecute(solutions: string[], testSets: string[], timeoutMs = 60_000): Promise<CrossExecutionResult> {
  const runs: TestRun[][] = [];
  for (const solution of solutions) {
    runs.push(await Promise.all(testSets.map((tests) => runTestsAgainst(solution, tests, timeoutMs))));
  }
  // Test identity = (set index, name); keep tests at least one solution passes.
  const usable = new Set<string>();
  for (let j = 0; j < testSets.length; j++) {
    const names = new Set<string>();
    for (const row of runs) for (const n of [...row[j]!.passed, ...Object.keys(row[j]!.failed)]) names.add(n);
    for (const n of names) if (runs.some((row) => row[j]!.passed.includes(n))) usable.add(`${j}:${n}`);
  }
  const scores = runs.map((row) => {
    let passed = 0;
    let importErrors = 0;
    const failures: string[] = [];
    row.forEach((r, j) => {
      if (r.importError !== undefined) importErrors += 1;
      for (const n of r.passed) if (usable.has(`${j}:${n}`)) passed += 1;
      for (const [n, err] of Object.entries(r.failed)) if (usable.has(`${j}:${n}`)) failures.push(`${n} (set ${j + 1}): ${err}`);
      if (r.importError !== undefined) failures.push(`import/collection error (set ${j + 1}): ${r.importError}`);
    });
    return { passed, total: usable.size, importErrors, failures };
  });
  return { scores, totalTests: usable.size };
}

// ── Computational scratchpad ───────────────────────────────────────────

const COMPUTE_MARKER = "# kernel-compute";

/** The proposer's `# kernel-compute` block, if any. */
export function extractComputeBlock(text: string): string | undefined {
  const blocks = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/gi)].map((m) => (m[1] ?? "").trim());
  return blocks.find((b) => b.startsWith(COMPUTE_MARKER));
}

export interface ComputeRun { stdout: string; stderr: string; exitCode: number; timedOut: boolean; durationMs: number }

/** Run a scratchpad program; stdout/stderr are truncated to keep the follow-up prompt bounded. */
export async function runComputeProgram(code: string, timeoutMs = 30_000, maxChars = 6_000): Promise<ComputeRun> {
  const started = performance.now();
  const dir = mkdtempSync(join(tmpdir(), "kernel-compute-"));
  try {
    writeFileSync(join(dir, "compute.py"), code.endsWith("\n") ? code : `${code}\n`, "utf8");
    const python = process.env.KERNEL_EXEC_PYTHON ?? "python3";
    const proc = Bun.spawn([python, "-I", "compute.py"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1", PYTHONHASHSEED: "0", HOME: dir, MPLBACKEND: "Agg" },
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutMs);
    const [exitCode, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    clearTimeout(timer);
    const clip = (t: string) => (t.length > maxChars ? `${t.slice(0, maxChars)}\n… [truncated ${t.length - maxChars} chars]` : t);
    return { stdout: clip(stdout), stderr: clip(stderr.split("\n").slice(-30).join("\n")), exitCode, timedOut, durationMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { stdout: "", stderr: err instanceof Error ? err.message : String(err), exitCode: -1, timedOut: false, durationMs: Math.round(performance.now() - started) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Compact, model-readable description of failures for a repair wave. */
export function describeFailures(check: ExecutionCheck, maxChars = 2_500): string {
  if (check.error !== undefined) return `The program failed to run: ${check.error}`;
  const parts = check.failures.slice(0, 3).map((f) => {
    const exp = JSON.stringify(f.expected);
    const got = f.error !== undefined ? `error ${f.error}` : JSON.stringify(f.got);
    return `- training pair ${f.index + 1}: expected ${exp.length > 600 ? `${exp.slice(0, 600)}…` : exp}; program produced ${got.length > 600 ? `${got.slice(0, 600)}…` : got}`;
  });
  const text = `The program reproduced ${check.passed}/${check.total} training pairs.\n${parts.join("\n")}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
