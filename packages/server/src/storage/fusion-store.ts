import { createHash, randomUUID } from "node:crypto";

import { getOperationalDb } from "./operational-db.ts";

export interface FusionIdentityInput {
  requestId: string;
  messages: unknown[];
  logicalModel: string;
  principalId?: string;
  extraHeaders?: Record<string, string>;
}

export interface FusionIdentity {
  conversationId: string;
  turnId: string;
  inputFingerprint: string;
  messageCount: number;
  client: string | undefined;
  project: string | undefined;
}

export interface FusionRunStart {
  fusionRunId: string;
  requestId: string;
  turnId: string;
  conversationId: string;
  logicalModel: string;
  effort: string;
  inputFingerprint: string;
  configFingerprint?: string;
  metadata?: Record<string, unknown>;
}

export interface FusionRunFinish {
  fusionRunId: string;
  status: "completed" | "failed";
  cacheKey?: string;
  cacheHit?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FusionSubagentRunStart {
  subagentRunId: string;
  fusionRunId: string;
  parentRunId?: string;
  subtaskId: string;
  focusArea: string;
  descriptionHash: string;
  modelRouting: string;
  metadata?: Record<string, unknown>;
}

export interface FusionSubagentRunFinish {
  subagentRunId: string;
  status: "completed" | "failed" | "cached" | "skipped";
  attemptCount?: number;
  durationMs?: number;
  outputHash?: string;
  metadata?: Record<string, unknown>;
}

export interface FusionUpstreamAttemptRecord {
  upstreamAttemptId?: string;
  parentRunId: string;
  fusionRunId: string;
  phase: string;
  provider?: string;
  model?: string;
  apiKeyEnvVar?: string;
  routeIndex?: number;
  attemptNumber: number;
  status: "running" | "completed" | "failed" | "cancelled";
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  metadata?: Record<string, unknown>;
}

export function resolveFusionIdentity(input: FusionIdentityInput): FusionIdentity {
  const headers = normalizeHeaders(input.extraHeaders);
  const conversationSeed =
    headers["x-opencode-session"] ??
    headers["x-session-affinity"] ??
    stableHash({
      principalId: input.principalId ?? "anonymous",
      logicalModel: input.logicalModel,
      firstSystemPrompt: extractSystemPrompt(input.messages),
    });
  const turnSeed = headers["x-opencode-request"] ?? input.requestId;
  const inputFingerprint = stableHash({
    logicalModel: input.logicalModel,
    messages: normalizeMessagesForFingerprint(input.messages),
  });
  return {
    conversationId: `conv_${stableHash(conversationSeed).slice(0, 32)}`,
    turnId: `turn_${stableHash({ conversationSeed, turnSeed }).slice(0, 32)}`,
    inputFingerprint,
    messageCount: input.messages.length,
    client: headers["x-opencode-client"],
    project: headers["x-opencode-project"],
  };
}

export function makeFusionRunId(requestId: string): string {
  return `frun_${stableHash({ requestId, nonce: randomUUID() }).slice(0, 32)}`;
}

export function makeFusionSubagentRunId(fusionRunId: string, subtaskId: string): string {
  return `fsag_${stableHash({ fusionRunId, subtaskId }).slice(0, 32)}`;
}

export function hashFusionValue(value: unknown): string {
  return stableHash(value);
}

export function recordFusionConversationTurn(input: {
  identity: FusionIdentity;
  requestId: string;
  principalId?: string;
}): void {
  const db = getOperationalDb();
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO fusion_conversations (
      conversation_id, client, project, principal_id, created_at, last_seen_at
    ) VALUES (
      $conversation_id, $client, $project, $principal_id, $now, $now
    )
    ON CONFLICT(conversation_id) DO UPDATE SET
      client = COALESCE(excluded.client, fusion_conversations.client),
      project = COALESCE(excluded.project, fusion_conversations.project),
      principal_id = COALESCE(excluded.principal_id, fusion_conversations.principal_id),
      last_seen_at = excluded.last_seen_at`,
  ).run({
    $conversation_id: input.identity.conversationId,
    $client: input.identity.client ?? null,
    $project: input.identity.project ?? null,
    $principal_id: input.principalId ?? null,
    $now: now,
  });

  db.query(
    `INSERT OR REPLACE INTO fusion_turns (
      turn_id, conversation_id, request_id, message_count, input_fingerprint, created_at
    ) VALUES (
      $turn_id, $conversation_id, $request_id, $message_count, $input_fingerprint, $now
    )`,
  ).run({
    $turn_id: input.identity.turnId,
    $conversation_id: input.identity.conversationId,
    $request_id: input.requestId,
    $message_count: input.identity.messageCount,
    $input_fingerprint: input.identity.inputFingerprint,
    $now: now,
  });
}

export function startFusionRun(input: FusionRunStart): void {
  getOperationalDb().query(
    `INSERT OR REPLACE INTO fusion_runs (
      fusion_run_id, request_id, turn_id, conversation_id, logical_model, effort,
      cache_key, cache_hit, input_fingerprint, config_fingerprint, status,
      started_at, completed_at, metadata_json
    ) VALUES (
      $fusion_run_id, $request_id, $turn_id, $conversation_id, $logical_model, $effort,
      NULL, 0, $input_fingerprint, $config_fingerprint, 'running',
      $started_at, NULL, $metadata_json
    )`,
  ).run({
    $fusion_run_id: input.fusionRunId,
    $request_id: input.requestId,
    $turn_id: input.turnId,
    $conversation_id: input.conversationId,
    $logical_model: input.logicalModel,
    $effort: input.effort,
    $input_fingerprint: input.inputFingerprint,
    $config_fingerprint: input.configFingerprint ?? null,
    $started_at: new Date().toISOString(),
    $metadata_json: stringifyMetadata(input.metadata),
  });
}

export function finishFusionRun(input: FusionRunFinish): void {
  getOperationalDb().query(
    `UPDATE fusion_runs SET
      status = $status,
      cache_key = COALESCE($cache_key, cache_key),
      cache_hit = COALESCE($cache_hit, cache_hit),
      completed_at = $completed_at,
      metadata_json = $metadata_json
    WHERE fusion_run_id = $fusion_run_id`,
  ).run({
    $fusion_run_id: input.fusionRunId,
    $status: input.status,
    $cache_key: input.cacheKey ?? null,
    $cache_hit: input.cacheHit === undefined ? null : input.cacheHit ? 1 : 0,
    $completed_at: new Date().toISOString(),
    $metadata_json: stringifyMetadata(input.metadata),
  });
}

export function startFusionSubagentRun(input: FusionSubagentRunStart): void {
  getOperationalDb().query(
    `INSERT OR REPLACE INTO fusion_subagent_runs (
      subagent_run_id, fusion_run_id, parent_run_id, subtask_id, focus_area,
      description_hash, model_routing, attempt_count, status, started_at,
      completed_at, duration_ms, output_hash, metadata_json
    ) VALUES (
      $subagent_run_id, $fusion_run_id, $parent_run_id, $subtask_id, $focus_area,
      $description_hash, $model_routing, 0, 'running', $started_at,
      NULL, NULL, NULL, $metadata_json
    )`,
  ).run({
    $subagent_run_id: input.subagentRunId,
    $fusion_run_id: input.fusionRunId,
    $parent_run_id: input.parentRunId ?? null,
    $subtask_id: input.subtaskId,
    $focus_area: input.focusArea,
    $description_hash: input.descriptionHash,
    $model_routing: input.modelRouting,
    $started_at: new Date().toISOString(),
    $metadata_json: stringifyMetadata(input.metadata),
  });
}

export function finishFusionSubagentRun(input: FusionSubagentRunFinish): void {
  getOperationalDb().query(
    `UPDATE fusion_subagent_runs SET
      status = $status,
      attempt_count = COALESCE($attempt_count, attempt_count),
      completed_at = $completed_at,
      duration_ms = COALESCE($duration_ms, duration_ms),
      output_hash = COALESCE($output_hash, output_hash),
      metadata_json = $metadata_json
    WHERE subagent_run_id = $subagent_run_id`,
  ).run({
    $subagent_run_id: input.subagentRunId,
    $status: input.status,
    $attempt_count: input.attemptCount ?? null,
    $completed_at: new Date().toISOString(),
    $duration_ms: input.durationMs ?? null,
    $output_hash: input.outputHash ?? null,
    $metadata_json: stringifyMetadata(input.metadata),
  });
}

export function recordFusionUpstreamAttempt(input: FusionUpstreamAttemptRecord): string {
  const id = input.upstreamAttemptId ?? `fup_${stableHash({ ...input, nonce: randomUUID() }).slice(0, 32)}`;
  const now = new Date().toISOString();
  getOperationalDb().query(
    `INSERT OR REPLACE INTO fusion_upstream_attempts (
      upstream_attempt_id, parent_run_id, fusion_run_id, phase, provider, model,
      api_key_env_var, route_index, attempt_number, status, latency_ms,
      prompt_tokens, completion_tokens, total_tokens, started_at, completed_at, metadata_json
    ) VALUES (
      $upstream_attempt_id, $parent_run_id, $fusion_run_id, $phase, $provider, $model,
      $api_key_env_var, $route_index, $attempt_number, $status, $latency_ms,
      $prompt_tokens, $completion_tokens, $total_tokens, $started_at, $completed_at, $metadata_json
    )`,
  ).run({
    $upstream_attempt_id: id,
    $parent_run_id: input.parentRunId,
    $fusion_run_id: input.fusionRunId,
    $phase: input.phase,
    $provider: input.provider ?? null,
    $model: input.model ?? null,
    $api_key_env_var: input.apiKeyEnvVar ?? null,
    $route_index: input.routeIndex ?? null,
    $attempt_number: input.attemptNumber,
    $status: input.status,
    $latency_ms: input.latencyMs ?? null,
    $prompt_tokens: input.promptTokens ?? null,
    $completion_tokens: input.completionTokens ?? null,
    $total_tokens: input.totalTokens ?? null,
    $started_at: now,
    $completed_at: input.status === "running" ? null : now,
    $metadata_json: stringifyMetadata(input.metadata),
  });
  return id;
}

function extractSystemPrompt(messages: unknown[]): unknown {
  for (const message of messages) {
    if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const obj = message as Record<string, unknown>;
    if (obj["role"] === "system") return obj["content"];
  }
  return undefined;
}

function normalizeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

function normalizeMessagesForFingerprint(messages: unknown[]): unknown[] {
  return messages.map((message) => {
    if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
    const obj = message as Record<string, unknown>;
    return {
      role: obj["role"],
      content: hashLargeValue(obj["content"]),
      tool_calls: hashLargeValue(obj["tool_calls"]),
      tool_call_id: obj["tool_call_id"],
      name: obj["name"],
    };
  });
}

function hashLargeValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = stableStringify(value);
  if (text.length <= 2_000) return value;
  return { sha256: stableHash(value), originalLength: text.length };
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`).join(",")}}`;
}

function stringifyMetadata(metadata: Record<string, unknown> | undefined): string {
  return JSON.stringify(metadata ?? {});
}
