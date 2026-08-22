import type { RequestLogRecord } from "../observability/ring-buffer.ts";
import type { Principal } from "./identity-store.ts";
import { readSignupSettings } from "./identity-store.ts";
import { getOperationalDb } from "./operational-db.ts";

export interface UserLimits {
  requestsPerMinute: number | undefined;
  requestsPerDay: number | undefined;
  tokensPerDay: number | undefined;
  costUsdPerDay: number | undefined;
  concurrentRequests: number | undefined;
}

export interface LimitDecision {
  allowed: boolean;
  reason?: string;
  limitType?: string;
}

interface LimitRow {
  requests_per_minute: number | null;
  requests_per_day: number | null;
  tokens_per_day: number | null;
  cost_usd_per_day: number | null;
  concurrent_requests: number | null;
}

export function getUserLimits(userId: string): UserLimits {
  const row = getOperationalDb()
    .query("SELECT * FROM user_limits WHERE user_id = $user_id")
    .get({ $user_id: userId }) as LimitRow | null;
  if (row !== null) return limitsFromRow(row);
  return limitsFromObject(readSignupSettings().defaultLimits);
}

export function setUserLimits(userId: string, limits: UserLimits): UserLimits {
  const now = new Date().toISOString();
  getOperationalDb()
    .query(
      `INSERT INTO user_limits (
        user_id, requests_per_minute, requests_per_day, tokens_per_day,
        cost_usd_per_day, concurrent_requests, updated_at
      ) VALUES (
        $user_id, $requests_per_minute, $requests_per_day, $tokens_per_day,
        $cost_usd_per_day, $concurrent_requests, $updated_at
      )
      ON CONFLICT(user_id) DO UPDATE SET
        requests_per_minute = excluded.requests_per_minute,
        requests_per_day = excluded.requests_per_day,
        tokens_per_day = excluded.tokens_per_day,
        cost_usd_per_day = excluded.cost_usd_per_day,
        concurrent_requests = excluded.concurrent_requests,
        updated_at = excluded.updated_at`,
    )
    .run({
      $user_id: userId,
      $requests_per_minute: limits.requestsPerMinute ?? null,
      $requests_per_day: limits.requestsPerDay ?? null,
      $tokens_per_day: limits.tokensPerDay ?? null,
      $cost_usd_per_day: limits.costUsdPerDay ?? null,
      $concurrent_requests: limits.concurrentRequests ?? null,
      $updated_at: now,
    });
  return getUserLimits(userId);
}

export function reserveRequest(p: Principal | undefined, estimatedTokens = 0): LimitDecision {
  if (p === undefined || p.ownerBypass || p.isOwner || p.userId === undefined) return { allowed: true };
  const limits = getUserLimits(p.userId);
  const now = new Date();
  const minute = bucketStart(now, "minute");
  const day = bucketStart(now, "day");
  const db = getOperationalDb();
  const minuteCount = getBucketCount(p.userId, "minute", minute, "request_count");
  if (limits.requestsPerMinute !== undefined && minuteCount >= limits.requestsPerMinute) {
    return { allowed: false, reason: "Request-per-minute limit exceeded.", limitType: "requests_per_minute" };
  }
  const dayCount = getBucketCount(p.userId, "day", day, "request_count");
  if (limits.requestsPerDay !== undefined && dayCount >= limits.requestsPerDay) {
    return { allowed: false, reason: "Request-per-day limit exceeded.", limitType: "requests_per_day" };
  }
  const dayTokens = getBucketCount(p.userId, "day", day, "token_count");
  if (limits.tokensPerDay !== undefined && dayTokens + estimatedTokens > limits.tokensPerDay) {
    return { allowed: false, reason: "Token-per-day limit exceeded.", limitType: "tokens_per_day" };
  }
  const tx = db.transaction(() => {
    incrementBucket(p.userId!, "minute", minute, { requests: 1 });
    incrementBucket(p.userId!, "day", day, { requests: 1 });
  });
  tx();
  return { allowed: true };
}

export function commitRequestUsage(record: RequestLogRecord): void {
  if (record.userId === undefined || record.ownerBypass === true) return;
  const totalTokens = record.totalTokens ?? 0;
  const userCostUsd = record.userCostUsd ?? 0;
  if (totalTokens <= 0 && userCostUsd <= 0) return;
  incrementBucket(record.userId, "day", bucketStart(new Date(record.completedAt ?? record.timestamp), "day"), {
    tokens: totalTokens,
    costUsd: userCostUsd,
  });
}

function incrementBucket(
  userId: string,
  bucketType: "minute" | "day",
  bucket: string,
  values: { requests?: number; tokens?: number; costUsd?: number },
): void {
  const now = new Date().toISOString();
  getOperationalDb()
    .query(
      `INSERT INTO usage_buckets (
        user_id, bucket_type, bucket_start, request_count, token_count, cost_usd, updated_at
      ) VALUES (
        $user_id, $bucket_type, $bucket_start, $request_count, $token_count, $cost_usd, $updated_at
      )
      ON CONFLICT(user_id, bucket_type, bucket_start) DO UPDATE SET
        request_count = request_count + excluded.request_count,
        token_count = token_count + excluded.token_count,
        cost_usd = cost_usd + excluded.cost_usd,
        updated_at = excluded.updated_at`,
    )
    .run({
      $user_id: userId,
      $bucket_type: bucketType,
      $bucket_start: bucket,
      $request_count: values.requests ?? 0,
      $token_count: values.tokens ?? 0,
      $cost_usd: values.costUsd ?? 0,
      $updated_at: now,
    });
}

function getBucketCount(
  userId: string,
  bucketType: "minute" | "day",
  bucket: string,
  column: "request_count" | "token_count",
): number {
  const row = getOperationalDb()
    .query(`SELECT ${column} AS value FROM usage_buckets WHERE user_id = $user_id AND bucket_type = $bucket_type AND bucket_start = $bucket_start`)
    .get({ $user_id: userId, $bucket_type: bucketType, $bucket_start: bucket }) as { value: number } | null;
  return row?.value ?? 0;
}

function bucketStart(date: Date, bucket: "minute" | "day"): string {
  const iso = date.toISOString();
  return bucket === "minute" ? `${iso.slice(0, 16)}:00.000Z` : `${iso.slice(0, 10)}T00:00:00.000Z`;
}

function limitsFromRow(row: LimitRow): UserLimits {
  return {
    requestsPerMinute: row.requests_per_minute ?? undefined,
    requestsPerDay: row.requests_per_day ?? undefined,
    tokensPerDay: row.tokens_per_day ?? undefined,
    costUsdPerDay: row.cost_usd_per_day ?? undefined,
    concurrentRequests: row.concurrent_requests ?? undefined,
  };
}

function limitsFromObject(input: Record<string, unknown>): UserLimits {
  return {
    requestsPerMinute: numberField(input["requests_per_minute"]),
    requestsPerDay: numberField(input["requests_per_day"]),
    tokensPerDay: numberField(input["tokens_per_day"]),
    costUsdPerDay: numberField(input["cost_usd_per_day"]),
    concurrentRequests: numberField(input["concurrent_requests"]),
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
