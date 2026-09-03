/**
 * Fusion Kernel domain types.
 *
 * The kernel is a deterministic coordinator: models are ephemeral workers that
 * receive bounded context capsules and return typed results. Durable state
 * lives in the per-conversation ledger, never inside a model context.
 */

export type EffortBand = "F2" | "F3" | "max";

export type WorkerRole = "intent" | "proposer" | "verifier" | "repair" | "checkpoint";

export interface KernelIntent {
  /** Primary objective, verbatim from the user (trimmed, bounded). */
  goal: string;
  /** Stable hash of the normalized goal text; used for replay/continuation detection. */
  goalHash: string;
  constraints: string[];
  deliverables: string[];
  acceptance: string[];
  ambiguities: string[];
  /** Coarse domain tags (swe, math, science, research, writing, data, ops, multimodal, general). */
  domains: string[];
  /** Conversation index of the user message that introduced this intent. */
  sourceMessageIndex: number;
  extractedBy: "deterministic" | "model";
}

export type FindingStatus = "accepted" | "disputed" | "rejected";

export interface KernelFinding {
  id: string;
  statement: string;
  status: FindingStatus;
  /** Model families whose proposals support this statement. */
  support: string[];
  /** Model families / verifiers that contradicted it. */
  contradictedBy: string[];
  /** Brief evidence or verifier note. */
  note?: string;
  wave: number;
}

export interface KernelPlanStep {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done" | "blocked";
}

export type NegativeKind = "tool_error" | "rejected_hypothesis" | "failed_strategy" | "repair_exhausted";

export interface KernelNegative {
  signature: string;
  kind: NegativeKind;
  detail: string;
  attempts: number;
  at: string;
}

export interface KernelSearchRecord {
  at: string;
  effort: EffortBand;
  waves: number;
  agreement: number;
  proposals: number;
  verifications: number;
  workKeys: string[];
  cachedWork: number;
  kind: "search" | "repair" | "checkpoint";
}

export interface KernelLedger {
  version: 1;
  conversationId: string;
  logicalModel: string;
  intent?: KernelIntent;
  plan: KernelPlanStep[];
  findings: KernelFinding[];
  disagreements: string[];
  negatives: KernelNegative[];
  /** Message index at which the active task began (the fresh_task user message). */
  taskStartIndex: number;
  /** Continuation steps executed since the last full search/checkpoint. */
  continuationSteps: number;
  /** Total continuation steps for the active task (observability). */
  totalContinuationSteps: number;
  lastSearch?: KernelSearchRecord;
  /** Compact summary of the last synthesized answer/plan for the active task. */
  lastAnswerSummary?: string;
  updatedAt: string;
}

export type TurnKind = "fresh_task" | "tool_continuation" | "trivial_ack" | "clarification" | "replay";

export interface ReplanDecision {
  needed: boolean;
  reasons: string[];
  /** Stable signature of the triggering tool error (for repair budgeting). */
  errorSignature?: string;
  errorExcerpt?: string;
}

export interface TurnClassification {
  kind: TurnKind;
  reason: string;
  /** Number of leading messages whose hashes matched the stored ledger hashes. */
  commonPrefix: number;
  deltaCount: number;
  /** Index of the latest substantive user instruction (-1 when none). */
  lastUserIndex: number;
  /** Trimmed text of that instruction. */
  lastUserText: string;
  lastUserHash: string;
  historyRewritten: boolean;
  replan: ReplanDecision;
}

export interface Proposal {
  id: string;
  family: string;
  routing: string;
  wave: number;
  answer: string;
  claims: string[];
  assumptions: string[];
  risks: string[];
  confidence: number | undefined;
  raw: string;
  workKey: string;
  cached: boolean;
  durationMs: number;
  success: boolean;
  error?: string;
}

export type Verdict = "accept" | "revise" | "reject";

export interface Verification {
  id: string;
  proposalId: string;
  family: string;
  routing: string;
  verdict: Verdict;
  issues: string[];
  counterexample?: string;
  /** Claims the verifier explicitly confirmed. */
  correctClaims: string[];
  confidence: number | undefined;
  raw: string;
  workKey: string;
  cached: boolean;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface ConsensusFinding {
  statement: string;
  status: FindingStatus;
  support: string[];
  contradictedBy: string[];
  note?: string;
}

export interface Consensus {
  agreement: number;
  claimConsensus: number;
  verifierAcceptRate: number;
  accepted: ConsensusFinding[];
  disputed: ConsensusFinding[];
  rejected: ConsensusFinding[];
  /** Verifier-raised issues not attached to a specific claim. */
  openIssues: string[];
  /** Number of distinct proposal families that returned a usable answer. */
  familiesAnswered: number;
}

export interface WaveWidths {
  proposals: number;
  verifiersPerCandidate: number;
  maxWaves: number;
}
