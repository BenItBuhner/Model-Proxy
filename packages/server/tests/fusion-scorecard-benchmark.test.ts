import { describe, expect, it } from "bun:test";

interface FusionScorecardBenchmarkReport {
  gate: {
    passed: boolean;
    expectedPassCount: number;
    expectedFailureCount: number;
    unexpectedCount: number;
    separationMargin: number;
    minSeparationMargin: number;
    elapsedHeadroomMs: number;
    rssHeadroomMb: number;
  };
  cases: Array<{
    name: string;
    expectedStatus: "pass" | "warn" | "fail";
    scorecard: {
      overall: number;
      details: {
        failedChecks: string[];
      };
    };
    review: {
      status: "pass" | "warn" | "fail";
      risks: string[];
    };
  }>;
}

describe("fusion scorecard benchmark command", () => {
  it("emits a passing gate with expected-pass and expected-fail controls", async () => {
    const proc = Bun.spawn(["bun", "run", "benchmarks/fusion-quality-scorecard.ts"], {
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, stderr).toBe(0);
    const report = JSON.parse(stdout.slice(stdout.indexOf("{"))) as FusionScorecardBenchmarkReport;

    expect(report.gate.passed).toBe(true);
    expect(report.gate.expectedPassCount).toBe(3);
    expect(report.gate.expectedFailureCount).toBe(1);
    expect(report.gate.unexpectedCount).toBe(0);
    expect(report.gate.separationMargin).toBeGreaterThanOrEqual(report.gate.minSeparationMargin);
    expect(report.gate.elapsedHeadroomMs).toBeGreaterThan(0);
    expect(report.gate.rssHeadroomMb).toBeGreaterThan(0);

    const negative = report.cases.find((item) => item.name === "negative-duplicated-low-context-advisories");
    expect(negative).toBeDefined();
    expect(negative?.expectedStatus).toBe("fail");
    expect(negative?.review.status).toBe("fail");
    expect(negative?.scorecard.overall).toBeLessThan(0.8);
    expect(negative?.scorecard.details.failedChecks).toContain("final model has no tool surface");
    expect(negative?.review.risks).toContain("sealed-subagent safety checks failed");
  }, 30_000);
});
