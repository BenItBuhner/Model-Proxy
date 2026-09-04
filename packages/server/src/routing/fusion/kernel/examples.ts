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

export function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
