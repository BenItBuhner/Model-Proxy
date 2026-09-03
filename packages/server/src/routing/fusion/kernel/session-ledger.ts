import { createLogger } from "../../../observability/logger.ts";
import { getOperationalDb } from "../../../storage/operational-db.ts";
import type { KernelIntent, KernelLedger } from "./types.ts";

const log = createLogger("routing.fusion.kernel.ledger");

const MAX_FINDINGS = 80;
const MAX_NEGATIVES = 60;
const MAX_PLAN_STEPS = 40;
const MAX_DISAGREEMENTS = 30;
const MAX_ANSWER_SUMMARY_CHARS = 2_400;

export interface LoadedLedger {
  ledger: KernelLedger;
  messageHashes: string[];
}

/**
 * Durable per-conversation kernel state (SQLite, write-through). The ledger is
 * the only place task state lives between turns; models never carry it.
 */
export class SessionLedgerStore {
  private readonly memory = new Map<string, LoadedLedger>();

  load(conversationId: string): LoadedLedger | undefined {
    const cached = this.memory.get(conversationId);
    if (cached !== undefined) return cached;
    try {
      const row = getOperationalDb()
        .query(
          `SELECT ledger_json, message_hashes_json FROM fusion_kernel_sessions WHERE conversation_id = $conversation_id`,
        )
        .get({ $conversation_id: conversationId }) as
        | { ledger_json: string; message_hashes_json: string }
        | undefined;
      if (row === undefined) return undefined;
      const ledger = JSON.parse(row.ledger_json) as KernelLedger;
      if (ledger.version !== 1) return undefined;
      const messageHashes = JSON.parse(row.message_hashes_json) as string[];
      const loaded = { ledger, messageHashes };
      this.memory.set(conversationId, loaded);
      return loaded;
    } catch (err) {
      log.warn("failed to load kernel ledger", { conversationId, error: String(err) });
      return undefined;
    }
  }

  save(ledger: KernelLedger, messageHashes: string[], policyVersion: number): void {
    const bounded = boundLedger({ ...ledger, updatedAt: new Date().toISOString() });
    this.memory.set(ledger.conversationId, { ledger: bounded, messageHashes });
    try {
      getOperationalDb()
        .query(
          `INSERT INTO fusion_kernel_sessions (
            conversation_id, logical_model, policy_version, ledger_json, message_hashes_json, updated_at
          ) VALUES (
            $conversation_id, $logical_model, $policy_version, $ledger_json, $message_hashes_json, $updated_at
          )
          ON CONFLICT(conversation_id) DO UPDATE SET
            logical_model = excluded.logical_model,
            policy_version = excluded.policy_version,
            ledger_json = excluded.ledger_json,
            message_hashes_json = excluded.message_hashes_json,
            updated_at = excluded.updated_at`,
        )
        .run({
          $conversation_id: bounded.conversationId,
          $logical_model: bounded.logicalModel,
          $policy_version: policyVersion,
          $ledger_json: JSON.stringify(bounded),
          $message_hashes_json: JSON.stringify(messageHashes),
          $updated_at: bounded.updatedAt,
        });
    } catch (err) {
      log.warn("failed to persist kernel ledger", { conversationId: ledger.conversationId, error: String(err) });
    }
  }

  delete(conversationId: string): void {
    this.memory.delete(conversationId);
    try {
      getOperationalDb()
        .query(`DELETE FROM fusion_kernel_sessions WHERE conversation_id = $conversation_id`)
        .run({ $conversation_id: conversationId });
    } catch (err) {
      log.warn("failed to delete kernel ledger", { conversationId, error: String(err) });
    }
  }

  /** Test/ops helper: drop the in-memory layer so the next load hits SQLite. */
  clearMemory(): void {
    this.memory.clear();
  }
}

export function newLedger(conversationId: string, logicalModel: string): KernelLedger {
  return {
    version: 1,
    conversationId,
    logicalModel,
    plan: [],
    findings: [],
    disagreements: [],
    negatives: [],
    taskStartIndex: 0,
    continuationSteps: 0,
    totalContinuationSteps: 0,
    updatedAt: new Date().toISOString(),
  };
}

/** Reset the active-task portion of the ledger for a fresh task, keeping negatives as memory. */
export function beginTask(ledger: KernelLedger, intent: KernelIntent, taskStartIndex: number): KernelLedger {
  return {
    ...ledger,
    intent,
    plan: [],
    findings: [],
    disagreements: [],
    taskStartIndex,
    continuationSteps: 0,
    totalContinuationSteps: 0,
    lastSearch: undefined,
    lastAnswerSummary: undefined,
  };
}

function boundLedger(ledger: KernelLedger): KernelLedger {
  return {
    ...ledger,
    plan: ledger.plan.slice(-MAX_PLAN_STEPS),
    findings: ledger.findings.slice(-MAX_FINDINGS),
    disagreements: ledger.disagreements.slice(-MAX_DISAGREEMENTS),
    negatives: ledger.negatives.slice(-MAX_NEGATIVES),
    lastAnswerSummary:
      ledger.lastAnswerSummary !== undefined && ledger.lastAnswerSummary.length > MAX_ANSWER_SUMMARY_CHARS
        ? `${ledger.lastAnswerSummary.slice(0, MAX_ANSWER_SUMMARY_CHARS - 3)}...`
        : ledger.lastAnswerSummary,
  };
}
