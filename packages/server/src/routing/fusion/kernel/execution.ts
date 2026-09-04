import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    writeFileSync(join(dir, "harness.py"), HARNESS.replace(/CPU_SECONDS/g, String(Math.max(1, Math.ceil(timeoutMs / 1000)))), "utf8");
    writeFileSync(join(dir, "inputs.json"), JSON.stringify({ inputs }), "utf8");
    const proc = Bun.spawn(["python3", "-I", "harness.py"], {
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
