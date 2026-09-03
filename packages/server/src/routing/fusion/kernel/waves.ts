import type { AnswerVote, AnswerVoteEntry, Consensus, ConsensusFinding, Proposal, Verdict, Verification } from "./types.ts";

/**
 * Wave post-processing: lenient structured-output parsing, claim clustering,
 * agreement scoring, and consensus construction. Pure functions — no I/O.
 */

export interface ParsedProposal {
  answer: string;
  claims: string[];
  assumptions: string[];
  risks: string[];
  confidence: number | undefined;
  finalAnswer?: string;
}

export interface ParsedVerdict {
  verdict: Verdict;
  issues: string[];
  counterexample?: string;
  correctClaims: string[];
  finalAnswerCorrect?: boolean;
  correctedFinalAnswer?: string;
  confidence: number | undefined;
}

function optionalAnswer(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  let trimmed = value.trim().replace(/^[`"'\s]+|[`"'\s]+$/g, "");
  if (trimmed.length === 0 || /^(null|none|n\/a|undefined)$/i.test(trimmed)) return undefined;
  // Template placeholders echoed from the task ("<letter>", "<answer>") are not answers.
  if (/^<[^>]{1,20}>/.test(trimmed)) return undefined;
  // Strip instruction echoes appended to a short answer: "A as the very last
  // line…", "699` on its own line.", "1736 as the last line, and put nothing after".
  const echo = trimmed.match(/^(.{1,40}?)(?:`|\s+(?:as|on|then|which|that way|so that)\b|[.,;]\s+(?:nothing|that|the|and|put|do)\b)/i);
  if (echo?.[1] !== undefined && echo[1].trim().length > 0 && trimmed.length > echo[1].length + 8) trimmed = echo[1].trim();
  trimmed = trimmed.replace(/^[`"'\s]+|[`"'\s.]+$/g, "");
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

/**
 * Normalize a final answer for vote tallying: case/whitespace-insensitive,
 * LaTeX wrappers and trivial punctuation removed, option letters and yes/no
 * canonicalized, integers with leading zeros equalized.
 */
export function normalizeFinalAnswer(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^[`"'*\s]+|[`"'*\s]+$/g, "").trim();
  s = s.replace(/^(?:final\s*answer|answer|final)\s*[:=]\s*/i, "");
  s = s.replace(/^\$+|\$+$/g, "");
  s = s.replace(/\\boxed\{([\s\S]*)\}/, "$1");
  s = s.replace(/\\text\{([^}]*)\}/g, "$1");
  s = s.replace(/\\d?frac\s*\{([^}]*)\}\s*\{([^}]*)\}/g, "$1/$2");
  s = s.replace(/\\(?:left|right|,|!|;)/g, "");
  s = s.replace(/[\s,]/g, "");
  s = s.replace(/[.。]$/, "");
  s = s.toLowerCase();
  const letter = s.match(/^\(?([a-j])\)?$/);
  if (letter !== null) return letter[1]!;
  if (/^(yes|true)$/.test(s)) return "yes";
  if (/^(no|false)$/.test(s)) return "no";
  if (/^-?\d+$/.test(s)) return String(Number(s));
  return s;
}

const MAX_CLAIMS = 12;
const MAX_CLAIM_CHARS = 400;

/** Find the last fenced JSON block (or trailing bare object) and parse it leniently. */
export function extractTrailingJson(text: string): Record<string, unknown> | undefined {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fenced.length - 1; i >= 0; i--) {
    const parsed = tryParseObject(fenced[i]![1] ?? "");
    if (parsed !== undefined) return parsed;
  }
  // Bare trailing object.
  const lastOpen = text.lastIndexOf("{");
  if (lastOpen >= 0) {
    const parsed = tryParseObject(text.slice(lastOpen));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function tryParseObject(raw: string): Record<string, unknown> | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  const candidates = [trimmed, repairJson(trimmed)];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // try next
    }
  }
  return undefined;
}

/** Common LLM JSON slips: trailing commas, unbalanced closing braces. */
function repairJson(raw: string): string {
  let text = raw.replace(/,\s*([}\]])/g, "$1");
  const opens = (text.match(/{/g) ?? []).length;
  const closes = (text.match(/}/g) ?? []).length;
  if (opens > closes) text += "}".repeat(opens - closes);
  return text;
}

function stringList(value: unknown, max = MAX_CLAIMS): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = typeof item === "string" ? item : typeof item === "object" && item !== null ? JSON.stringify(item) : String(item ?? "");
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (cleaned.length === 0) continue;
    out.push(cleaned.length > MAX_CLAIM_CHARS ? `${cleaned.slice(0, MAX_CLAIM_CHARS - 3)}...` : cleaned);
    if (out.length >= max) break;
  }
  return out;
}

function confidenceOf(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return n > 1 ? Math.min(1, n / 100) : Math.max(0, n);
}

/** Body text with the trailing structured block removed. */
export function stripTrailingJson(text: string): string {
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const lastFence = fences[fences.length - 1];
  if (lastFence !== undefined && lastFence.index !== undefined) {
    const after = text.slice(lastFence.index + lastFence[0].length);
    if (after.trim().length === 0 && tryParseObject(lastFence[1] ?? "") !== undefined) {
      return text.slice(0, lastFence.index).trimEnd();
    }
  }
  const lastOpen = text.lastIndexOf("{");
  if (lastOpen > 0 && tryParseObject(text.slice(lastOpen)) !== undefined) return text.slice(0, lastOpen).trimEnd();
  return text;
}

export function parseProposal(raw: string): ParsedProposal {
  const json = extractTrailingJson(raw);
  const body = stripTrailingJson(raw).trim();
  const claims = stringList(json?.["key_claims"] ?? json?.["claims"]);
  const summary = typeof json?.["answer_summary"] === "string" ? (json["answer_summary"] as string).trim() : "";
  return {
    answer: body.length > 0 ? body : summary,
    claims: claims.length > 0 ? claims : fallbackClaims(body),
    assumptions: stringList(json?.["assumptions"], 8),
    risks: stringList(json?.["risks"], 8),
    confidence: confidenceOf(json?.["confidence"]),
    finalAnswer: optionalAnswer(json?.["final_answer"]) ?? fallbackFinalAnswer(body),
  };
}

/** When the structured block lacks a final answer, honor an explicit FINAL:/boxed answer in the body. */
function fallbackFinalAnswer(body: string): string | undefined {
  const finalLine = [...body.matchAll(/\**\s*FINAL\s*(?:ANSWER)?\s*:\s*\**\s*([^\n]+?)\s*\**\s*(?=\n|$)/gi)];
  const last = finalLine[finalLine.length - 1]?.[1]?.trim();
  if (last !== undefined && last.length > 0) return last.length > 200 ? `${last.slice(0, 197)}...` : last;
  const boxed = body.lastIndexOf("\\boxed{");
  if (boxed >= 0) {
    const start = boxed + "\\boxed{".length;
    let depth = 1;
    for (let i = start; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") {
        depth--;
        if (depth === 0) return body.slice(start, i).trim();
      }
    }
  }
  return undefined;
}

/** When a worker omits the structured block, mine bullet/numbered lines as claims. */
function fallbackClaims(body: string): string[] {
  const lines = body.split("\n").map((line) => line.trim());
  const bullets = lines
    .filter((line) => /^([-*•]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^([-*•]|\d+[.)])\s+/, "").replace(/\s+/g, " ").trim())
    .filter((line) => line.length >= 12);
  if (bullets.length >= 2) return bullets.slice(0, MAX_CLAIMS);
  const sentences = body
    .replace(/```[\s\S]*?```/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 24 && s.length <= MAX_CLAIM_CHARS);
  return sentences.slice(0, Math.min(6, sentences.length));
}

export function parseVerdict(raw: string): ParsedVerdict {
  const json = extractTrailingJson(raw);
  const verdictRaw = typeof json?.["verdict"] === "string" ? (json["verdict"] as string).toLowerCase() : "";
  let verdict: Verdict;
  if (verdictRaw.startsWith("accept") || verdictRaw === "pass" || verdictRaw === "ok") verdict = "accept";
  else if (verdictRaw.startsWith("reject") || verdictRaw === "fail") verdict = "reject";
  else if (verdictRaw.startsWith("revise") || verdictRaw === "partial") verdict = "revise";
  else verdict = inferVerdictFromText(raw);
  const counterexampleRaw = json?.["counterexample"];
  const counterexample =
    typeof counterexampleRaw === "string" && counterexampleRaw.trim().length > 0 && !/^(null|none|n\/a)$/i.test(counterexampleRaw.trim())
      ? counterexampleRaw.trim()
      : undefined;
  const finalCorrectRaw = json?.["candidate_final_answer_correct"];
  const finalAnswerCorrect =
    typeof finalCorrectRaw === "boolean"
      ? finalCorrectRaw
      : typeof finalCorrectRaw === "string" && /^(true|false)$/i.test(finalCorrectRaw.trim())
        ? finalCorrectRaw.trim().toLowerCase() === "true"
        : undefined;
  return {
    verdict,
    issues: stringList(json?.["issues"], 10),
    counterexample,
    correctClaims: stringList(json?.["correct_claims"] ?? json?.["confirmed"], 12),
    finalAnswerCorrect,
    correctedFinalAnswer: optionalAnswer(json?.["corrected_final_answer"]),
    confidence: confidenceOf(json?.["confidence"]),
  };
}

/** True when some whitespace/punctuation-delimited prefix of `raw` normalizes to `key`. */
function rawHasAnswerPrefix(raw: string, key: string): boolean {
  for (let i = 1; i < raw.length; i++) {
    if (/[a-zA-Z0-9]/.test(raw[i] ?? "")) continue;
    if (normalizeFinalAnswer(raw.slice(0, i)) === key) return true;
  }
  return false;
}

/**
 * A vote is decisive when every reasoner declared the same final answer and
 * the audits that judged it confirm it more often than they reject it (or no
 * audit ran but ≥3 voters agree). Decisive votes stop escalation and switch
 * synthesis to presentation mode regardless of how poorly prose claims cluster.
 */
export function isDecisiveVote(vote: AnswerVote | undefined, verifications: Verification[]): boolean {
  if (vote === undefined || vote.leader === undefined || vote.voters < 2) return false;
  const leader = vote.leader;
  const proposerFamilies = (e: AnswerVoteEntry) => e.families.filter((f) => !f.startsWith("verifier:"));
  const leaderFamilies = proposerFamilies(leader);
  if (vote.unanimous) {
    // Only explicit judgments of the final answer count; a "reject" verdict on
    // presentation grounds is not evidence that the answer is wrong.
    const usable = verifications.filter((v) => v.success);
    const explicit = usable.filter((v) => v.finalAnswerCorrect !== undefined);
    const confirms = explicit.filter((v) => v.finalAnswerCorrect === true).length + usable.filter((v) => v.finalAnswerCorrect === undefined && v.verdict === "accept").length;
    const rejects = explicit.filter((v) => v.finalAnswerCorrect === false).length;
    if (confirms === 0 && rejects === 0) return vote.voters >= 3 || leaderFamilies.length >= 2;
    if (confirms > rejects) return true;
    // Three independent families agreeing outweigh a single dissenting audit.
    return leaderFamilies.length >= 3 && rejects <= 1;
  }
  // Strong majority: the leader is backed by ≥2 families with ≥70% of the
  // weight, every dissenting answer comes from ONE family, and no family
  // outside that dissenting camp rejected the leader. A family that proposed
  // the minority answer gets no second vote through its verifier.
  const others = vote.entries.filter((e) => e !== leader && e.weight > 0);
  const dissentFamilies = new Set(others.flatMap(proposerFamilies));
  if (leaderFamilies.length < 2 || vote.leaderShare < 0.7 || dissentFamilies.size > 1) return false;
  const independentRejects = leader.rejectFamilies.filter((f) => !dissentFamilies.has(f));
  if (independentRejects.length > 0) return false;
  // An independent confirmation comes from a family that neither proposed the
  // leader nor the dissent: a third, uncommitted family.
  const independentConfirms = leader.confirmFamilies.filter((f) => !dissentFamilies.has(f) && !leaderFamilies.includes(f));
  return independentConfirms.length >= 1 || leaderFamilies.length >= 3;
}

/**
 * Weighted final-answer vote. Each proposal with a final answer casts 1 vote;
 * a verifier confirming the candidate's answer adds +0.5 to it, a verifier
 * rejecting it subtracts 0.5 and (when it supplies a corrected answer) adds
 * +0.5 to the corrected one. Weights are clamped at 0.
 */
export function buildAnswerVote(proposals: Proposal[], verifications: Verification[]): AnswerVote | undefined {
  const entries = new Map<string, AnswerVoteEntry>();
  const bump = (raw: string, weight: number, family?: string, judge?: { family: string; confirm: boolean }) => {
    const key = normalizeFinalAnswer(raw);
    if (key.length === 0) return;
    const entry = entries.get(key) ?? { key, answer: raw, weight: 0, families: [], verifierConfirms: 0, verifierRejects: 0, confirmFamilies: [], rejectFamilies: [] };
    entry.weight += weight;
    if (family !== undefined && !entry.families.includes(family)) entry.families.push(family);
    if (judge !== undefined) {
      if (judge.confirm) {
        entry.verifierConfirms += 1;
        if (!entry.confirmFamilies.includes(judge.family)) entry.confirmFamilies.push(judge.family);
      } else {
        entry.verifierRejects += 1;
        if (!entry.rejectFamilies.includes(judge.family)) entry.rejectFamilies.push(judge.family);
      }
    }
    entries.set(key, entry);
  };
  let voters = 0;
  for (const p of proposals) {
    if (!p.success || p.finalAnswer === undefined) continue;
    voters += 1;
    bump(p.finalAnswer, 1, p.family);
  }
  if (voters === 0) return undefined;
  const byId = new Map(proposals.map((p) => [p.id, p]));
  for (const v of verifications) {
    if (!v.success || v.finalAnswerCorrect === undefined) continue;
    const candidate = byId.get(v.proposalId);
    if (candidate?.finalAnswer === undefined) continue;
    if (v.finalAnswerCorrect) bump(candidate.finalAnswer, 0.5, undefined, { family: v.family, confirm: true });
    else {
      bump(candidate.finalAnswer, -0.5, undefined, { family: v.family, confirm: false });
      if (v.correctedFinalAnswer !== undefined) bump(v.correctedFinalAnswer, 0.5, `verifier:${v.family}`);
    }
  }
  // Merge sloppy declarations into their clean form: "1736 as the last line"
  // normalizes to a key that starts with "1736" followed by a non-alphanumeric
  // boundary, so it is the same answer with trailing prose.
  const keys = [...entries.keys()].sort((a, b) => a.length - b.length);
  for (const longer of keys) {
    const raw = entries.get(longer)?.answer ?? "";
    const short = keys.find((k) => k !== longer && k.length < longer.length && longer.startsWith(k) && rawHasAnswerPrefix(raw, k));
    if (short === undefined) continue;
    const target = entries.get(short);
    const source = entries.get(longer);
    if (target === undefined || source === undefined) continue;
    target.weight += source.weight;
    target.verifierConfirms += source.verifierConfirms;
    target.verifierRejects += source.verifierRejects;
    for (const f of source.families) if (!target.families.includes(f)) target.families.push(f);
    for (const f of source.confirmFamilies) if (!target.confirmFamilies.includes(f)) target.confirmFamilies.push(f);
    for (const f of source.rejectFamilies) if (!target.rejectFamilies.includes(f)) target.rejectFamilies.push(f);
    entries.delete(longer);
  }
  const list = [...entries.values()].map((e) => ({ ...e, weight: Math.max(0, Math.round(e.weight * 100) / 100) })).sort((a, b) => b.weight - a.weight);
  const total = list.reduce((s, e) => s + e.weight, 0);
  const leader = list[0];
  return {
    entries: list,
    leader,
    leaderShare: total > 0 && leader !== undefined ? Math.round((leader.weight / total) * 1000) / 1000 : 0,
    unanimous: list.filter((e) => e.weight > 0).length === 1 && voters >= 2,
    voters,
  };
}

function inferVerdictFromText(raw: string): Verdict {
  const lower = raw.toLowerCase();
  if (/\b(incorrect|wrong|fails|counterexample|reject)\b/.test(lower)) return "reject";
  if (/\b(missing|incomplete|should also|needs? (to|revision)|revise)\b/.test(lower)) return "revise";
  return "accept";
}

// ── Claim clustering / agreement ──────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "be", "that", "this",
  "it", "as", "by", "at", "from", "was", "were", "will", "should", "can", "not", "we", "you", "they", "its",
]);

export function claimTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/`[^`]*`/g, (m) => m.replace(/`/g, ""))
    .split(/[^a-z0-9_./-]+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
  return new Set(tokens);
}

export function claimSimilarity(a: string, b: string): number {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  // Containment rescues short-vs-long phrasings of the same fact.
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment * 0.85);
}

const CLUSTER_THRESHOLD = 0.42;

interface ClaimCluster {
  representative: string;
  members: Array<{ proposalId: string; family: string; claim: string }>;
  families: Set<string>;
}

export function clusterClaims(proposals: Proposal[]): ClaimCluster[] {
  const clusters: ClaimCluster[] = [];
  for (const proposal of proposals) {
    if (!proposal.success) continue;
    for (const claim of proposal.claims) {
      let best: ClaimCluster | undefined;
      let bestScore = 0;
      for (const cluster of clusters) {
        const score = claimSimilarity(cluster.representative, claim);
        if (score > bestScore) {
          bestScore = score;
          best = cluster;
        }
      }
      if (best !== undefined && bestScore >= CLUSTER_THRESHOLD) {
        best.members.push({ proposalId: proposal.id, family: proposal.family, claim });
        best.families.add(proposal.family);
        // Prefer the shortest phrasing as representative for the brief.
        if (claim.length < best.representative.length && claim.length >= 20) best.representative = claim;
      } else {
        clusters.push({
          representative: claim,
          members: [{ proposalId: proposal.id, family: proposal.family, claim }],
          families: new Set([proposal.family]),
        });
      }
    }
  }
  return clusters;
}

/**
 * Build consensus from proposals + verifications.
 *
 * agreement = 0.55·claimConsensus + 0.45·verifierAcceptRate, where
 * claimConsensus is the share of claims (weighted by cluster size) that at
 * least two distinct families independently asserted, and verifierAcceptRate
 * counts accept=1, revise=0.5, reject=0 across successful verifications.
 * A single answering family cannot exceed 0.5 claim consensus by construction.
 */
export function buildConsensus(proposals: Proposal[], verifications: Verification[]): Consensus {
  const usable = proposals.filter((p) => p.success && (p.answer.length > 0 || p.claims.length > 0));
  const familiesAnswered = new Set(usable.map((p) => p.family)).size;
  const clusters = clusterClaims(usable);

  const rejectedProposalIds = new Set(
    verifications.filter((v) => v.success && v.verdict === "reject").map((v) => v.proposalId),
  );
  const verificationsByProposal = new Map<string, Verification[]>();
  for (const v of verifications) {
    if (!v.success) continue;
    const list = verificationsByProposal.get(v.proposalId) ?? [];
    list.push(v);
    verificationsByProposal.set(v.proposalId, list);
  }

  let weightedShared = 0;
  let weightedTotal = 0;
  const accepted: ConsensusFinding[] = [];
  const disputed: ConsensusFinding[] = [];
  const rejected: ConsensusFinding[] = [];

  for (const cluster of clusters) {
    const weight = cluster.members.length;
    weightedTotal += weight;
    const multiFamily = cluster.families.size >= 2;
    if (multiFamily) weightedShared += weight;

    // Verifier evidence about the proposals that asserted this claim.
    const memberProposalIds = new Set(cluster.members.map((m) => m.proposalId));
    const memberVerifications = [...memberProposalIds].flatMap((id) => verificationsByProposal.get(id) ?? []);
    const confirmed = memberVerifications.some((v) =>
      v.correctClaims.some((c) => claimSimilarity(c, cluster.representative) >= CLUSTER_THRESHOLD),
    );
    const contradictingIssues = memberVerifications.flatMap((v) =>
      v.issues.filter((issue) => claimSimilarity(issue, cluster.representative) >= CLUSTER_THRESHOLD).map((issue) => ({ family: v.family, issue })),
    );
    const allRejected = [...memberProposalIds].every((id) => rejectedProposalIds.has(id));
    const anyAccepted = memberVerifications.some((v) => v.verdict === "accept");

    const finding: ConsensusFinding = {
      statement: cluster.representative,
      status: "accepted",
      support: [...cluster.families],
      contradictedBy: [...new Set(contradictingIssues.map((c) => c.family))],
      note: contradictingIssues[0]?.issue,
    };

    if (allRejected && memberVerifications.length > 0 && !multiFamily && !confirmed) {
      // Every proposal asserting this single-source claim was rejected outright.
      finding.status = "rejected";
      finding.note = finding.note ?? memberVerifications.find((v) => v.verdict === "reject")?.issues[0];
      rejected.push(finding);
    } else if (contradictingIssues.length > 0) {
      // A verifier raised an issue that overlaps this claim: dispute it, never
      // reject on wording overlap alone (issues often mention a claim while
      // objecting to its justification, not its truth).
      finding.status = "disputed";
      disputed.push(finding);
    } else if (multiFamily || confirmed || anyAccepted) {
      accepted.push(finding);
    } else if (memberVerifications.length === 0 && usable.length === 1) {
      // Single proposer, no verifier: cannot be accepted as consensus — keep as disputed for the synthesizer to weigh.
      finding.status = "disputed";
      finding.note = "single-source, unverified";
      disputed.push(finding);
    } else {
      finding.status = "disputed";
      finding.note = finding.note ?? "single-source";
      disputed.push(finding);
    }
  }

  const successfulVerifications = verifications.filter((v) => v.success);
  const verifierAcceptRate = successfulVerifications.length === 0
    ? 0
    : successfulVerifications.reduce((sum, v) => sum + (v.verdict === "accept" ? 1 : v.verdict === "revise" ? 0.5 : 0), 0) /
      successfulVerifications.length;
  const claimConsensus = weightedTotal === 0 ? 0 : weightedShared / weightedTotal;

  // Verifier issues not tied to a specific claim cluster.
  const attachedIssues = new Set(disputed.concat(rejected).map((f) => f.note).filter((n): n is string => n !== undefined));
  const openIssues = [...new Set(
    successfulVerifications.flatMap((v) => v.issues).filter((issue) => !attachedIssues.has(issue)),
  )].slice(0, 12);

  const answerVote = buildAnswerVote(usable, verifications);
  let agreement: number;
  if (answerVote !== undefined && answerVote.voters >= 2) {
    // Short-answer tasks: the answer vote is the strongest signal of agreement.
    // A single voter cannot certify itself (share capped at 0.5).
    const answerConsensus = answerVote.leaderShare;
    agreement = successfulVerifications.length === 0
      ? 0.5 * claimConsensus + 0.5 * answerConsensus
      : 0.35 * claimConsensus + 0.3 * verifierAcceptRate + 0.35 * answerConsensus;
  } else if (answerVote !== undefined) {
    agreement = Math.min(0.5, successfulVerifications.length === 0 ? claimConsensus : 0.55 * claimConsensus + 0.45 * verifierAcceptRate);
  } else {
    agreement = successfulVerifications.length === 0
      ? claimConsensus
      : 0.55 * claimConsensus + 0.45 * verifierAcceptRate;
  }
  // Math/MC prose clusters poorly even when every reasoner reached the same
  // answer; a decisive vote must not be dragged below threshold by that.
  if (isDecisiveVote(answerVote, verifications)) agreement = Math.max(agreement, 0.8);

  return {
    agreement: round3(agreement),
    claimConsensus: round3(claimConsensus),
    verifierAcceptRate: round3(verifierAcceptRate),
    answerVote,
    accepted: accepted.sort((a, b) => b.support.length - a.support.length),
    disputed,
    rejected,
    openIssues,
    familiesAnswered,
  };
}

/** Count claims in `next` that are not similar to anything in `previous` (novelty for livelock detection). */
export function novelClaimCount(previous: string[], next: string[]): number {
  let novel = 0;
  for (const claim of next) {
    const seen = previous.some((prev) => claimSimilarity(prev, claim) >= CLUSTER_THRESHOLD);
    if (!seen) novel++;
  }
  return novel;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
