import { describe, expect, it } from "bun:test";
import { gradeExact, gradeGrid, gradeMc, gradeNumeric, gradeNumericTolerant, normalizeExact } from "../benchmarks/kernel-bench/graders.ts";

describe("kernel-bench graders", () => {
  it("compares closed-form LaTeX answers numerically, including pi adjacent to digits", () => {
    expect(gradeNumeric("FINAL: $\\frac{8\\pi}{3}+2\\sqrt{3}$", "2 \\sqrt{3}+\\frac{8 \\pi}{3}").correct).toBe(true);
    expect(gradeNumeric("FINAL: 4\\pi", "2 \\sqrt{3}+\\frac{8 \\pi}{3}").correct).toBe(false);
    expect(gradeNumeric("FINAL: $259,487", "259487").correct).toBe(true);
  });

  it("grades BBEH-style exact answers case/punctuation-insensitively and treats (B) as B", () => {
    expect(normalizeExact("**(B)**.")).toBe("b");
    expect(gradeExact("reasoning...\nFINAL: (B)", "(B)").correct).toBe(true);
    expect(gradeExact("FINAL: B", "(B)").correct).toBe(true);
    expect(gradeExact("FINAL: Yes.", "yes").correct).toBe(true);
    expect(gradeExact("FINAL: 1,024", "1024").correct).toBe(true);
    expect(gradeExact("FINAL: valid", "invalid").correct).toBe(false);
  });

  it("grades finance answers with a relative tolerance and percent-scale equivalence", () => {
    expect(gradeNumericTolerant("FINAL: 14.1", "0.14136", 0.01, true).correct).toBe(true);
    expect(gradeNumericTolerant("FINAL: 0.141", "0.14136", 0.01, true).correct).toBe(true);
    expect(gradeNumericTolerant("FINAL: 15", "0.14136", 0.01, true).correct).toBe(false);
    expect(gradeNumericTolerant("FINAL: 94", "94.0", 0.01, true).correct).toBe(true);
    expect(gradeNumericTolerant("FINAL: 14.1", "0.14136", 0.01, false).correct).toBe(false);
  });

  it("grades letters and grids", () => {
    expect(gradeMc("FINAL: C", "C").correct).toBe(true);
    expect(gradeGrid("Explanation with [[1,2]] example.\n```json\n[[3,4],[5,6]]\n```", "[[3,4],[5,6]]").correct).toBe(true);
  });
});
