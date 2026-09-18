/**
 * Detection of input/output examples embedded in a task, so candidate
 * programs can be checked against ground truth instead of trusted.
 *
 * Supported shapes:
 *  - Labelled blocks: "Input ...:" / "Output ...:" pairs and "Test input ...:"
 *    followed by a JSON value (ARC-style grids, lists, numbers, strings).
 *  - Raw ARC JSON: {"train": [{"input": ..., "output": ...}], "test": [{"input": ...}]}
 *  - Arrays of {"input": ..., "output": ...} objects.
 */

export interface IoExample {
  input: unknown;
  output: unknown;
}

export interface TaskExamples {
  examples: IoExample[];
  /** Test inputs the program must be applied to (may be empty). */
  tests: unknown[];
}

/** Parse the first balanced JSON value ([...] or {...}) starting at or after `from`. */
function parseJsonValueAt(text: string, from: number): { value: unknown; end: number } | undefined {
  let i = from;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  const open = text[i];
  if (open !== "[" && open !== "{") {
    // Scalars: numbers / quoted strings on the same line.
    const scalar = /^(-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*")/.exec(text.slice(i, i + 200));
    if (scalar === null) return undefined;
    try {
      return { value: JSON.parse(scalar[1]!), end: i + scalar[1]!.length };
    } catch {
      return undefined;
    }
  }
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inString = false;
  for (let j = i; j < text.length; j++) {
    const ch = text[j]!;
    if (inString) {
      if (ch === "\\") j++;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return { value: JSON.parse(text.slice(i, j + 1)), end: j + 1 };
        } catch {
          return undefined;
        }
      }
    }
    if (j - i > 400_000) return undefined;
  }
  return undefined;
}

function fromRawArc(text: string): TaskExamples | undefined {
  const idx = text.indexOf("\"train\"");
  if (idx < 0) return undefined;
  const start = text.lastIndexOf("{", idx);
  if (start < 0) return undefined;
  const parsed = parseJsonValueAt(text, start);
  const obj = parsed?.value as { train?: unknown; test?: unknown } | undefined;
  if (obj === undefined || !Array.isArray(obj.train)) return undefined;
  const examples = (obj.train as Array<Record<string, unknown>>)
    .filter((p) => p !== null && typeof p === "object" && "input" in p && "output" in p)
    .map((p) => ({ input: p["input"], output: p["output"] }));
  const tests = Array.isArray(obj.test) ? (obj.test as Array<Record<string, unknown>>).map((t) => t["input"]).filter((v) => v !== undefined) : [];
  return examples.length > 0 ? { examples, tests } : undefined;
}

function fromLabelledBlocks(text: string): TaskExamples | undefined {
  const label = /(test\s+input|input|output|expected\s+output|test)\b[^\n]{0,60}?:\s*\n?/gi;
  const examples: IoExample[] = [];
  const tests: unknown[] = [];
  let pendingInput: { value: unknown } | undefined;
  let m: RegExpExecArray | null;
  while ((m = label.exec(text)) !== null) {
    const kind = m[1]!.toLowerCase().replace(/\s+/g, " ");
    const parsed = parseJsonValueAt(text, m.index + m[0].length);
    if (parsed === undefined) continue;
    label.lastIndex = parsed.end;
    if (kind === "test input" || kind === "test") {
      tests.push(parsed.value);
      pendingInput = undefined;
    } else if (kind === "input") {
      pendingInput = { value: parsed.value };
    } else if (pendingInput !== undefined) {
      examples.push({ input: pendingInput.value, output: parsed.value });
      pendingInput = undefined;
    }
  }
  return examples.length > 0 ? { examples, tests } : undefined;
}

/** Extract examples from task text; undefined when the task has no checkable examples. */
export function extractIoExamples(text: string): TaskExamples | undefined {
  if (text.length > 2_000_000) return undefined;
  return fromRawArc(text) ?? fromLabelledBlocks(text);
}

/** Last JSON grid (array of arrays of integers) in a response; fenced blocks are preferred. */
export function extractGridAnswer(text: string): number[][] | undefined {
  const sources: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)) sources.push(m[1] ?? "");
  sources.push(text);
  for (const source of sources.reverse()) {
    let best: number[][] | undefined;
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== "[" || source[i + 1] !== "[") continue;
      const parsed = parseJsonValueAt(source, i);
      if (parsed === undefined) continue;
      const v = parsed.value;
      if (Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r) && r.every((x) => Number.isInteger(x)))) best = v as number[][];
      i = parsed.end - 1;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

/** All JSON grids in a response, in order (fenced blocks first, then loose text). */
export function extractAllGrids(text: string): number[][][] {
  const grids: number[][][] = [];
  const scan = (source: string) => {
    for (let i = 0; i < source.length; i++) {
      if (source[i] !== "[" || source[i + 1] !== "[") continue;
      const parsed = parseJsonValueAt(source, i);
      if (parsed === undefined) continue;
      const v = parsed.value;
      if (Array.isArray(v) && v.length > 0 && v.every((r) => Array.isArray(r) && r.every((x) => Number.isInteger(x)))) grids.push(v as number[][]);
      i = parsed.end - 1;
    }
  };
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1] ?? "");
  if (fenced.length > 0) for (const f of fenced) scan(f);
  else scan(text);
  return grids;
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface CodeTask {
  language: "python";
  /** Function the task asks for, when a signature is given (e.g. `task_func`). */
  entryPoint?: string;
}

/**
 * Detect a Python code-synthesis task (a function/program to write, graded by
 * hidden tests): a python fence or `def name(` signature plus an instruction
 * to write/implement code. Such tasks have no checkable examples, so the
 * kernel verifies candidates by cross-executing proposer-written tests.
 */
export function detectCodeTask(text: string): CodeTask | undefined {
  if (text.length > 200_000) return undefined;
  const hasPythonFence = /```\s*(python|py)?\s*\n[\s\S]*?\bdef\s+\w+\s*\(/i.test(text) || /```[\s\S]*?\bimport\s+\w+[\s\S]*?```/.test(text);
  const signature = /\bdef\s+([A-Za-z_]\w*)\s*\(/.exec(text);
  const asksForCode = /\b(write|implement|complete|return|provide)\b[^.\n]{0,80}\b(code|function|solution|program|implementation)\b/i.test(text) || /self-contained code/i.test(text);
  if (!(hasPythonFence || signature !== null) || !asksForCode) return undefined;
  return { language: "python", entryPoint: signature?.[1] };
}

/** True for a rectangular 2-D grid of small non-negative integers (ARC-style). */
export function isIntGrid(value: unknown): value is number[][] {
  if (!Array.isArray(value) || value.length === 0) return false;
  const width = Array.isArray(value[0]) ? (value[0] as unknown[]).length : -1;
  if (width <= 0) return false;
  return value.every((row) => Array.isArray(row) && row.length === width && row.every((c) => Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 99));
}

const gridColors = (g: number[][]): Set<number> => new Set(g.flat());

/**
 * Regularities every training pair shares that a candidate test output should
 * respect. A program that reproduces the training pairs but breaks all of
 * them on the test input is the classic "fits the examples for the wrong
 * reason" failure: an all-4s grid, a 2x2 answer to a 14x14 task. Each returned
 * string names a violated regularity; an empty list means the candidate is
 * consistent (or the pairs share no regularity to check).
 */
export function gridConsistencyIssues(examples: IoExample[], testInput: unknown, candidate: unknown): string[] {
  const pairs = examples.filter((e) => isIntGrid(e.input) && isIntGrid(e.output)) as Array<{ input: number[][]; output: number[][] }>;
  if (pairs.length < 2 || !isIntGrid(testInput) || !isIntGrid(candidate)) return [];
  const issues: string[] = [];
  const dims = (g: number[][]) => [g.length, g[0]!.length] as const;
  const [tH, tW] = dims(testInput);
  const [cH, cW] = dims(candidate);
  // Shape: same-as-input, transposed, or a constant integer ratio. A constant
  // output size across the training pairs is deliberately NOT a rule: on the
  // ARC-AGI-2 evaluation set 3 of 120 tasks share output dimensions across every
  // training pair by coincidence and then change size on the test input
  // (38007db0, a32d8b75, e87109e9); the rules kept here flag 0 of 120 ground truths.
  const same = pairs.every((p) => dims(p.output)[0] === dims(p.input)[0] && dims(p.output)[1] === dims(p.input)[1]);
  const transposed = pairs.every((p) => dims(p.output)[0] === dims(p.input)[1] && dims(p.output)[1] === dims(p.input)[0]);
  const ratio = pairs.every((p) => dims(p.output)[0] % dims(p.input)[0] === 0 && dims(p.output)[1] % dims(p.input)[1] === 0 && dims(p.output)[0] / dims(p.input)[0] === dims(pairs[0]!.output)[0] / dims(pairs[0]!.input)[0] && dims(p.output)[1] / dims(p.input)[1] === dims(pairs[0]!.output)[1] / dims(pairs[0]!.input)[1]);
  if (same && !(cH === tH && cW === tW)) issues.push(`every training output has its input's dimensions; the candidate is ${cH}x${cW} for a ${tH}x${tW} input`);
  else if (transposed && !same && !(cH === tW && cW === tH)) issues.push(`every training output is its input transposed in shape; the candidate is ${cH}x${cW} for a ${tH}x${tW} input`);
  else if (ratio && !same) {
    const rh = dims(pairs[0]!.output)[0] / dims(pairs[0]!.input)[0], rw = dims(pairs[0]!.output)[1] / dims(pairs[0]!.input)[1];
    if (!(cH === tH * rh && cW === tW * rw)) issues.push(`every training output is ${rh}x${rw} times its input; the candidate is ${cH}x${cW} for a ${tH}x${tW} input`);
  }
  // Palette: colours in every training output come from its input plus colours common to all outputs.
  const commonOut = pairs.map((p) => gridColors(p.output)).reduce((acc, s) => new Set([...acc].filter((c) => s.has(c))));
  const paletteRule = pairs.every((p) => [...gridColors(p.output)].every((c) => gridColors(p.input).has(c) || commonOut.has(c)));
  if (paletteRule) {
    const allowed = new Set([...gridColors(testInput), ...commonOut]);
    const foreign = [...gridColors(candidate)].filter((c) => !allowed.has(c));
    if (foreign.length > 0) issues.push(`training outputs only use colours from their input (plus ${[...commonOut].join(",") || "none"}); the candidate introduces ${foreign.join(",")}`);
  }
  // Same-shape tasks: when every training pair keeps each non-background input
  // cell in place (or at least never erases it to background), so must the
  // candidate. Both rules flag 0/120 ARC-AGI-2 ground truths.
  // Only grids with a clear background (a strictly most common colour) take part.
  const sameShapePairs = pairs.every((p) => dims(p.output)[0] === dims(p.input)[0] && dims(p.output)[1] === dims(p.input)[1]);
  const background = (g: number[][]): number | undefined => {
    const m = new Map<number, number>();
    for (const r of g) for (const c of r) m.set(c, (m.get(c) ?? 0) + 1);
    const ranked = [...m.entries()].sort((x, y) => y[1] - x[1]);
    return ranked.length === 1 || ranked[0]![1] > (ranked[1]?.[1] ?? 0) ? ranked[0]![0] : undefined;
  };
  const testBackground = background(testInput);
  if (sameShapePairs && cH === tH && cW === tW && testBackground !== undefined && pairs.every((p) => background(p.input) !== undefined)) {
    const keepsCells = (input: number[][], output: number[][]) => { const b = background(input); return input.every((r, i) => r.every((x, j) => x === b || output[i]![j] === x)); };
    const keepsPainted = (input: number[][], output: number[][]) => { const b = background(input); return input.every((r, i) => r.every((x, j) => x === b || output[i]![j] !== b)); };
    if (pairs.every((p) => keepsCells(p.input, p.output)) && !keepsCells(testInput, candidate)) issues.push("every training output keeps each non-background input cell unchanged in place; the candidate repaints or erases some");
    else if (pairs.every((p) => keepsPainted(p.input, p.output)) && !keepsPainted(testInput, candidate)) issues.push("no training output erases a non-background input cell to background; the candidate does");
  }
  // Degenerate: a single-colour output when no training output is single-colour.
  const constantGrid = (g: number[][]) => gridColors(g).size === 1 && g.length * g[0]!.length >= 4;
  if (constantGrid(candidate) && !pairs.some((p) => constantGrid(p.output))) issues.push("the candidate is a single-colour grid while no training output is");
  return issues;
}
