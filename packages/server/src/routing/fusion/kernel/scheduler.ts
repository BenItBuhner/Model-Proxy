import type { FusionKernelConfig } from "@model-proxy/contracts/schemas/fusion.ts";
import type { FusionEffortLevel } from "../types.ts";
import type { Consensus, EffortBand, WaveWidths } from "./types.ts";

export type RequestedKernelEffort = "auto" | "low" | "medium" | "high" | "max";

/**
 * Read the client's effort intent. Supports the standard `reasoning_effort`,
 * the legacy `fusion_effort`, and the `fusion: { effort }` extension object
 * (ignored by ordinary OpenAI clients).
 */
export function parseRequestedKernelEffort(requestData: Record<string, unknown>): RequestedKernelEffort {
  const ext = requestData["fusion"];
  const extEffort = typeof ext === "object" && ext !== null ? (ext as Record<string, unknown>)["effort"] : undefined;
  const raw = extEffort ?? requestData["fusion_effort"] ?? requestData["reasoning_effort"] ?? "auto";
  if (typeof raw !== "string") return "auto";
  const normalized = raw.toLowerCase();
  if (normalized === "max" || normalized === "maximum" || normalized === "xhigh") return "max";
  if (normalized === "low" || normalized === "minimal") return "low";
  if (normalized === "medium" || normalized === "high" || normalized === "auto") return normalized;
  return "auto";
}

/**
 * Map the resolved F-level (+ explicit request) to the kernel's effort band.
 * An explicit `high` is a request for more compute regardless of how simple
 * the prompt looks (short AIME problems score as low complexity), so it maps
 * to F3; `max` maps to max.
 */
export function effortBandFor(
  resolved: FusionEffortLevel | undefined,
  requested: RequestedKernelEffort,
  domainHint?: { domains: string[]; effortByDomain: Record<string, EffortBand> },
): EffortBand {
  if (requested === "max") return "max";
  if (requested === "high" || resolved === "F3") return "F3";
  // Domain floor only when the client left effort to the kernel (`auto`): an
  // explicit low/medium is a deliberate budget choice and is respected.
  if (requested === "auto" && domainHint !== undefined) {
    const rank: Record<EffortBand, number> = { F2: 0, F3: 1, max: 2 };
    let band: EffortBand = "F2";
    for (const domain of domainHint.domains) {
      const floor = domainHint.effortByDomain[domain];
      if (floor !== undefined && rank[floor] > rank[band]) band = floor;
    }
    return band;
  }
  return "F2";
}

export function widthsFor(config: FusionKernelConfig, band: EffortBand, familyCount: number): WaveWidths {
  const proposals = Math.max(1, config.proposal_width[band]);
  // Never ask for more verifiers than there are other families to draw from
  // (unless there is only one family, in which case alternates verify).
  const otherFamilies = Math.max(1, familyCount - 1);
  const verifiersPerCandidate = Math.max(0, Math.min(config.verifiers_per_candidate[band], Math.max(otherFamilies, 1)));
  return {
    proposals,
    verifiersPerCandidate,
    maxWaves: Math.max(1, config.max_waves[band]),
  };
}

export interface EscalationDecision {
  escalate: boolean;
  reason: string;
}

/**
 * Decide whether to run another proposal wave. Escalate when agreement is
 * below threshold and there is room; stop on livelock (no novel accepted
 * claims in the last wave) or when the search has saturated.
 */
export function decideEscalation(args: {
  consensus: Consensus;
  wave: number;
  widths: WaveWidths;
  agreementThreshold: number;
  novelClaimsLastWave: number;
  familyCount: number;
}): EscalationDecision {
  const { consensus, wave, widths, agreementThreshold, novelClaimsLastWave, familyCount } = args;
  if (wave >= widths.maxWaves) {
    return { escalate: false, reason: `wave budget reached (${wave}/${widths.maxWaves})` };
  }
  if (consensus.familiesAnswered === 0) {
    return { escalate: true, reason: "no usable proposals; retrying with a different strategy" };
  }
  if (consensus.agreement >= agreementThreshold) {
    return { escalate: false, reason: `agreement ${consensus.agreement} ≥ threshold ${agreementThreshold}` };
  }
  if (wave > 1 && novelClaimsLastWave === 0) {
    return { escalate: false, reason: "no novel claims in the last wave (saturated); stopping" };
  }
  if (consensus.familiesAnswered < Math.min(2, familyCount)) {
    return { escalate: true, reason: `only ${consensus.familiesAnswered} family answered; widening` };
  }
  return {
    escalate: true,
    reason: `agreement ${consensus.agreement} < threshold ${agreementThreshold}; ${consensus.disputed.length} disputed / ${consensus.openIssues.length} open issue(s)`,
  };
}

/** Guidance injected into escalation-wave proposers so they do not resample the same reasoning. */
export function escalationStrategyNote(consensus: Consensus, wave: number): string {
  const vote = consensus.answerVote;
  const lines: string[] = [
    `This is proposal wave ${wave}. Earlier independent reasoners disagreed; do not simply restate a generic answer.`,
  ];
  if (vote !== undefined && vote.entries.filter((e) => e.weight > 0).length > 1) {
    // Short-answer split: present the camps neutrally. Prior verdicts on the
    // final answer are NOT evidence — a single noisy audit must not herd this
    // wave away from the right answer.
    const camps = vote.entries.filter((e) => e.weight > 0).slice(0, 4).map((e) => `"${e.answer}" (${e.families.filter((f) => !f.startsWith("verifier:")).join(", ") || "audit correction"})`);
    lines.push(`Earlier reasoners split on the final answer: ${camps.join(" vs ")}.`);
    lines.push("Re-derive the answer independently from first principles. Do not defer to either camp or to earlier verdicts (they may be wrong). Identify the exact step where the camps diverge, work it out carefully, and state which answer is right and precisely why the other fails.");
  } else {
    lines.push("Take a materially different approach where the earlier reasoning was disputed, resolve the disputed points explicitly, and state which side is right and why.");
  }
  if (consensus.disputed.length > 0) {
    lines.push(vote !== undefined ? "Disputed points (verifier opinions — check them yourself):" : "Disputed points to resolve:");
    for (const finding of consensus.disputed.slice(0, 8)) {
      lines.push(`  - ${finding.statement}${finding.note !== undefined ? ` (verifier: ${finding.note})` : ""}`);
    }
  }
  // For voted tasks a rejected claim is usually "the answer is X" as judged by
  // one verifier; presenting it as refuted would bias the wave. Only surface
  // refutations that come with a concrete counterexample.
  const refuted = vote !== undefined
    ? consensus.rejected.filter((f) => f.note !== undefined && /counterexample|contradict|violates|fails (?:for|when|at)/i.test(f.note))
    : consensus.rejected;
  if (refuted.length > 0) {
    lines.push("Claims already refuted (avoid repeating them):");
    for (const finding of refuted.slice(0, 6)) {
      lines.push(`  - ${finding.statement}${finding.note !== undefined ? ` — ${finding.note}` : ""}`);
    }
  }
  if (consensus.openIssues.length > 0) {
    lines.push("Open issues raised by verifiers:");
    for (const issue of consensus.openIssues.slice(0, 6)) lines.push(`  - ${issue}`);
  }
  if (consensus.accepted.length > 0) {
    lines.push("Already agreed (do not re-derive; build on these):");
    for (const finding of consensus.accepted.slice(0, 6)) lines.push(`  - ${finding.statement}`);
  }
  return lines.join("\n");
}
