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
