import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchItem } from "./types.ts";

/**
 * Graders. Answer extraction is deliberately generous (FINAL: line, then
 * \boxed{}, then a trailing "answer is X", then the last number) and
 * normalization is symmetric so no model is favored by formatting.
 */

export function extractFinalLine(text: string): string | undefined {
  // FINAL may be bolded, indented, or share a line with preceding prose.
  const matches = [...text.matchAll(/\**\s*FINAL\s*:\s*\**\s*([^\n]+?)\s*\**\s*(?=\n|$)/gi)];
  const last = matches[matches.length - 1];
  const value = last?.[1]?.trim().replace(/^\**|\**$/g, "").trim();
  return value !== undefined && value.length > 0 ? value : undefined;
}

function lastBoxed(text: string): string | undefined {
  let idx = text.lastIndexOf("\\boxed{");
  if (idx < 0) idx = text.lastIndexOf("\\boxed ");
  if (idx < 0) return undefined;
  const start = text.indexOf("{", idx);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return undefined;
}

/** Replace every `\frac{a}{b}` / `\dfrac` / `\tfrac` with `(a)/(b)`, honoring nested braces. */
function convertFracs(input: string): string {
  let s = input;
  for (;;) {
    const m = /\\[dt]?frac\s*\{/.exec(s);
    if (m === null) return s;
    const start = m.index;
    const readGroup = (from: number): { text: string; end: number } | undefined => {
      if (s[from] !== "{") return undefined;
      let depth = 0;
      for (let i = from; i < s.length; i++) {
        if (s[i] === "{") depth++;
        else if (s[i] === "}") {
          depth--;
          if (depth === 0) return { text: s.slice(from + 1, i), end: i + 1 };
        }
      }
      return undefined;
    };
    const num = readGroup(start + m[0].length - 1);
    if (num === undefined) return s;
    let j = num.end;
    while (s[j] === " ") j++;
    const den = readGroup(j);
    if (den === undefined) return s;
    s = `${s.slice(0, start)}(${num.text})/(${den.text})${s.slice(den.end)}`;
  }
}

/**
 * Evaluate a normalized math answer numerically when it is a closed-form
 * expression over integers, fractions, sqrt, pi and + - * / ^. Returns
 * undefined for anything else (variables, sets, intervals, text).
 */
export function evaluateMathAnswer(normalized: string): number | undefined {
  let s = normalized;
  if (s.length === 0 || s.length > 200) return undefined;
  s = s.replace(/[{]/g, "(").replace(/[}]/g, ")");
  s = s.replace(/sqrt\(([^()]*)\)/g, "Math.sqrt($1)");
  s = s.replace(/sqrt(\d+(?:\.\d+)?)/g, "Math.sqrt($1)");
  s = s.replace(/\bpi\b/g, "Math.PI");
  s = s.replace(/\^/g, "**");
  // Implicit multiplication: 2Math.sqrt(...), 3Math.PI, )(, 2(  →  insert *
  s = s.replace(/(\d)(Math\.)/g, "$1*$2");
  s = s.replace(/\)(\d|Math\.|\()/g, ")*$1");
  s = s.replace(/(\d)\(/g, "$1*(");
  if (!/^[0-9+\-*/().\s]*(Math\.(sqrt|PI)[0-9+\-*/().\s]*)*$/.test(s.replace(/Math\.(sqrt|PI)/g, ""))) return undefined;
  if (/[a-zA-Z]/.test(s.replace(/Math\.sqrt|Math\.PI/g, ""))) return undefined;
  try {
    const value = Function(`"use strict"; return (${s});`)() as unknown;
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeMathAnswer(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^\$+|\$+$/g, "").trim();
  s = s.replace(/^\\[(\[]\s*|\s*\\[)\]]$/g, "").trim();
  s = s.replace(/^\$+|\$+$/g, "").trim();
  s = s.replace(/\\boxed\{([\s\S]*)\}/, "$1");
  s = s.replace(/\\text\{([^}]*)\}/g, "$1");
  s = s.replace(/\\(?:left|right|,|!|;|quad|qquad|displaystyle)/g, "");
  s = convertFracs(s);
  s = s.replace(/\^\s*\{?\\circ\}?|°/g, "");
  s = s.replace(/\\%|%/g, "");
  s = s.replace(/\\cdot|\\times/g, "*");
  s = s.replace(/\\sqrt\s*\{([^}]*)\}/g, "sqrt($1)");
  s = s.replace(/\\sqrt\s*([a-z0-9]+)/g, "sqrt($1)");
  s = s.replace(/\\pi/g, "pi");
  s = s.replace(/\\infty/g, "inf");
  s = s.replace(/(?:dollars?|units?|cm|km|m|kg|degrees?|inches|feet|meters?)\b\.?$/i, "");
  // Thousands separators only; list/tuple commas are significant.
  s = s.replace(/(\d),(?=\d{3}(?!\d))/g, "$1");
  s = s.replace(/\s/g, "");
  s = s.replace(/\.$/, "");
  s = s.replace(/^\((-?[\d./]+)\)$/, "$1");
  // Unwrap parentheses around single tokens produced by \frac conversion: (pi)/(2) -> pi/2
  s = s.replace(/\((-?[a-z0-9.]+)\)/g, "$1");
  s = s.replace(/^x=|^y=|^n=|^k=/, "");
  return s.toLowerCase();
}

function numericValue(s: string): number | undefined {
  const frac = s.match(/^(-?\d+)\/(\d+)$/);
  if (frac !== null) return Number(frac[1]) / Number(frac[2]);
  const mixed = s.match(/^(-?\d+)\s*(\d+)\/(\d+)$/);
  if (mixed !== null) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(s)) return Number(s);
  return undefined;
}

export function extractNumericAnswer(text: string): string | undefined {
  const final = extractFinalLine(text);
  if (final !== undefined && final.length > 0) return final;
  const boxed = lastBoxed(text);
  if (boxed !== undefined) return boxed;
  const answerIs = [...text.matchAll(/answer\s*(?:is|:)\s*\**\s*([^\n.]+?)\s*\**\s*(?:\.|\n|$)/gi)];
  const lastAnswer = answerIs[answerIs.length - 1]?.[1];
  if (lastAnswer !== undefined) return lastAnswer.trim();
  const nums = text.match(/-?\d+(?:\.\d+)?(?:\/\d+)?/g);
  return nums !== null ? nums[nums.length - 1] : undefined;
}

export function gradeNumeric(text: string, expected: string): { predicted: string | undefined; correct: boolean } {
  const raw = extractNumericAnswer(text);
  if (raw === undefined) return { predicted: undefined, correct: false };
  const p = normalizeMathAnswer(raw);
  const e = normalizeMathAnswer(expected);
  if (p === e) return { predicted: raw, correct: true };
  const pv = numericValue(p) ?? evaluateMathAnswer(p);
  const ev = numericValue(e) ?? evaluateMathAnswer(e);
  if (pv !== undefined && ev !== undefined && Number.isFinite(pv) && Number.isFinite(ev)) {
    const tol = Math.max(1e-6, Math.abs(ev) * 1e-6);
    return { predicted: raw, correct: Math.abs(pv - ev) <= tol };
  }
  // Integer answers written with leading zeros (AIME "042" vs "42").
  if (/^\d+$/.test(p) && /^\d+$/.test(e)) return { predicted: raw, correct: Number(p) === Number(e) };
  return { predicted: raw, correct: false };
}

export function extractLetter(text: string): string | undefined {
  const final = extractFinalLine(text);
  const fromFinal = final?.match(/\(?([A-J])\)?/i)?.[1];
  if (fromFinal !== undefined) return fromFinal.toUpperCase();
  const answerIs = [...text.matchAll(/answer\s*(?:is|:)\s*\**\s*\(?([A-J])\)?(?![a-z])/gi)];
  const last = answerIs[answerIs.length - 1]?.[1];
  if (last !== undefined) return last.toUpperCase();
  const tail = text.slice(-200).match(/\b\(?([A-J])\)?\s*\.?\s*$/);
  return tail?.[1]?.toUpperCase();
}

export function gradeMc(text: string, expected: string): { predicted: string | undefined; correct: boolean } {
  const predicted = extractLetter(text);
  return { predicted, correct: predicted !== undefined && predicted === expected.trim().toUpperCase() };
}

export function gradeYesNo(text: string, expected: string): { predicted: string | undefined; correct: boolean } {
  const final = extractFinalLine(text) ?? text.slice(-120);
  const m = final.match(/\b(yes|no)\b/i);
  const predicted = m?.[1] !== undefined ? m[1][0]!.toUpperCase() + m[1].slice(1).toLowerCase() : undefined;
  return { predicted, correct: predicted !== undefined && predicted.toLowerCase() === expected.trim().toLowerCase() };
}

export function extractPythonCode(text: string): string | undefined {
  const blocks = [...text.matchAll(/```(?:python|py)?\s*\n([\s\S]*?)```/gi)].map((m) => m[1] ?? "");
  if (blocks.length === 0) return undefined;
  // Prefer the block that defines a function; otherwise the longest.
  const withDef = blocks.filter((b) => /^\s*def\s+\w+/m.test(b));
  const pool = withDef.length > 0 ? withDef : blocks;
  return pool.sort((a, b) => b.length - a.length)[0];
}

/** Execute a HumanEval-style item: candidate code + official tests, in a temp dir with a timeout. */
export async function gradeCode(text: string, item: BenchItem): Promise<{ predicted: string; correct: boolean; detail?: string }> {
  const code = extractPythonCode(text);
  if (code === undefined || item.code === undefined) return { predicted: "no-code", correct: false };
  const entry = item.code.entryPoint;
  // If the model returned only a body (no def), prepend the original prompt.
  const program = new RegExp(`^\\s*def\\s+${entry}\\s*\\(`, "m").test(code) ? code : `${item.code.prompt}\n${code}`;
  const source = `${program}\n\n${item.code.test}\n\ncheck(${entry})\n`;
  const dir = mkdtempSync(join(tmpdir(), "kernel-bench-code-"));
  const file = join(dir, "candidate.py");
  writeFileSync(file, source, "utf8");
  try {
    const proc = Bun.spawn(["python3", file], { cwd: dir, stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", PYTHONDONTWRITEBYTECODE: "1" } });
    const timer = setTimeout(() => proc.kill(), 15_000);
    const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    clearTimeout(timer);
    return { predicted: exitCode === 0 ? "pass" : "fail", correct: exitCode === 0, detail: exitCode === 0 ? undefined : stderr.slice(-600) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function gradeItem(item: BenchItem, text: string): Promise<{ predicted?: string; expected?: string; correct?: boolean; detail?: string }> {
  switch (item.kind) {
    case "numeric": {
      const g = gradeNumeric(text, item.answer ?? "");
      return { predicted: g.predicted, expected: item.answer, correct: g.correct };
    }
    case "mc": {
      const g = gradeMc(text, item.answer ?? "");
      return { predicted: g.predicted, expected: item.answer, correct: g.correct };
    }
    case "yesno": {
      const g = gradeYesNo(text, item.answer ?? "");
      return { predicted: g.predicted, expected: item.answer, correct: g.correct };
    }
    case "code": {
      const g = await gradeCode(text, item);
      return { predicted: g.predicted, expected: "pass", correct: g.correct, detail: g.detail };
    }
    case "open":
      return {};
  }
}
