import { stableHash } from "../../../shared/utils.ts";
import { createLogger } from "../../../observability/logger.ts";
import { getOperationalDb } from "../../../storage/operational-db.ts";
import type { NegativeKind, WorkerRole } from "./types.ts";

const log = createLogger("routing.fusion.kernel.work");

export const WORK_KEY_VERSION = 1;

export interface WorkSpec {
  kind: WorkerRole | "synthesis";
  /** What the worker is asked to do (verbatim objective text). */
  objective: string;
  /** Hash of everything the worker can read (capsule read set). */
  readSetHash: string;
  modelRouting: string;
  /** Strategy tag — wave number, "distinct approach", repair, etc. */
  strategy: string;
  policyVersion: number;
  configFingerprint: string;
}

export interface WorkRecord<T = unknown> {
  workKey: string;
  kind: string;
  modelRouting: string;
  status: "completed" | "failed";
  result: T;
  createdAt: string;
  hitCount: number;
}

export interface NegativeRecord {
  signature: string;
  conversationId: string;
  kind: NegativeKind;
  detail: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Content-addressed key: identical objective + identical readable state +
 * identical model/strategy/policy ⇒ identical work. Anything else is new work.
 */
export function computeWorkKey(spec: WorkSpec): string {
  return stableHash({ v: WORK_KEY_VERSION, ...spec }).slice(0, 40);
}

/**
 * Persistent cache of completed worker results plus a negative-result ledger
 * so failed strategies are not retried against unchanged state.
 */
export class WorkCache {
  get<T = unknown>(workKey: string): WorkRecord<T> | undefined {
    try {
      const row = getOperationalDb()
        .query(
          `SELECT work_key, kind, model_routing, status, result_json, created_at, hit_count
           FROM fusion_kernel_work WHERE work_key = $work_key`,
        )
        .get({ $work_key: workKey }) as
        | {
            work_key: string;
            kind: string;
            model_routing: string;
            status: "completed" | "failed";
            result_json: string;
            created_at: string;
            hit_count: number;
          }
        | null
        | undefined;
      if (row === undefined || row === null) return undefined;
      getOperationalDb()
        .query(`UPDATE fusion_kernel_work SET hit_count = hit_count + 1, last_hit_at = $now WHERE work_key = $work_key`)
        .run({ $work_key: workKey, $now: new Date().toISOString() });
      return {
        workKey: row.work_key,
        kind: row.kind,
        modelRouting: row.model_routing,
        status: row.status,
        result: JSON.parse(row.result_json) as T,
        createdAt: row.created_at,
        hitCount: row.hit_count + 1,
      };
    } catch (err) {
      log.debug("work cache read failed", { workKey, error: String(err) });
      return undefined;
    }
  }

  put(
    workKey: string,
    spec: Pick<WorkSpec, "kind" | "modelRouting">,
    result: unknown,
    status: "completed" | "failed",
    conversationId?: string,
  ): void {
    try {
      getOperationalDb()
        .query(
          `INSERT OR REPLACE INTO fusion_kernel_work (
            work_key, kind, model_routing, status, result_json, conversation_id, created_at, hit_count, last_hit_at
          ) VALUES (
            $work_key, $kind, $model_routing, $status, $result_json, $conversation_id, $created_at, 0, NULL
          )`,
        )
        .run({
          $work_key: workKey,
          $kind: spec.kind,
          $model_routing: spec.modelRouting,
          $status: status,
          $result_json: JSON.stringify(result),
          $conversation_id: conversationId ?? null,
          $created_at: new Date().toISOString(),
        });
    } catch (err) {
      log.warn("work cache write failed", { workKey, error: String(err) });
    }
  }

  delete(workKey: string): void {
    try {
      getOperationalDb().query(`DELETE FROM fusion_kernel_work WHERE work_key = $work_key`).run({ $work_key: workKey });
    } catch (err) {
      log.debug("work cache delete failed", { workKey, error: String(err) });
    }
  }

  /** Record (or bump) a negative result for this conversation. Returns the attempt count. */
  recordNegative(conversationId: string, signature: string, kind: NegativeKind, detail: string): number {
    const now = new Date().toISOString();
    try {
      getOperationalDb()
        .query(
          `INSERT INTO fusion_kernel_negatives (
            signature, conversation_id, kind, detail_json, attempts, created_at, updated_at
          ) VALUES (
            $signature, $conversation_id, $kind, $detail_json, 1, $now, $now
          )
          ON CONFLICT(conversation_id, signature) DO UPDATE SET
            attempts = fusion_kernel_negatives.attempts + 1,
            kind = excluded.kind,
            detail_json = excluded.detail_json,
            updated_at = excluded.updated_at`,
        )
        .run({
          $signature: signature,
          $conversation_id: conversationId,
          $kind: kind,
          $detail_json: JSON.stringify(detail),
          $now: now,
        });
      return this.getNegative(conversationId, signature)?.attempts ?? 1;
    } catch (err) {
      log.warn("negative record write failed", { conversationId, signature, error: String(err) });
      return 1;
    }
  }

  getNegative(conversationId: string, signature: string): NegativeRecord | undefined {
    try {
      const row = getOperationalDb()
        .query(
          `SELECT signature, conversation_id, kind, detail_json, attempts, created_at, updated_at
           FROM fusion_kernel_negatives WHERE conversation_id = $conversation_id AND signature = $signature`,
        )
        .get({ $conversation_id: conversationId, $signature: signature }) as
        | {
            signature: string;
            conversation_id: string;
            kind: NegativeKind;
            detail_json: string;
            attempts: number;
            created_at: string;
            updated_at: string;
          }
        | null
        | undefined;
      if (row === undefined || row === null) return undefined;
      return {
        signature: row.signature,
        conversationId: row.conversation_id,
        kind: row.kind,
        detail: JSON.parse(row.detail_json) as string,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    } catch (err) {
      log.debug("negative record read failed", { conversationId, signature, error: String(err) });
      return undefined;
    }
  }

  listNegatives(conversationId: string, limit = 20): NegativeRecord[] {
    try {
      const rows = getOperationalDb()
        .query(
          `SELECT signature, conversation_id, kind, detail_json, attempts, created_at, updated_at
           FROM fusion_kernel_negatives WHERE conversation_id = $conversation_id
           ORDER BY updated_at DESC LIMIT $limit`,
        )
        .all({ $conversation_id: conversationId, $limit: limit }) as Array<{
          signature: string;
          conversation_id: string;
          kind: NegativeKind;
          detail_json: string;
          attempts: number;
          created_at: string;
          updated_at: string;
        }>;
      return rows.map((row) => ({
        signature: row.signature,
        conversationId: row.conversation_id,
        kind: row.kind,
        detail: JSON.parse(row.detail_json) as string,
        attempts: row.attempts,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } catch (err) {
      log.debug("negative list failed", { conversationId, error: String(err) });
      return [];
    }
  }
}
