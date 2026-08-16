"use client";

import { apiFetch } from "./api";

export interface HealthDetailed {
  status: string;
  uptime_seconds: number;
  auth_configured: boolean;
  models_count: number;
  providers_count: number;
  models: string[];
  providers: string[];
  runtime: { bun?: string; platform?: string; arch?: string; node_env?: string };
}

export interface RequestLogRecord {
  requestId: string;
  timestamp: string;
  completedAt?: string;
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  apiKeyEnvVar?: string;
  keyHint?: string;
  wireProtocol?: "openai" | "anthropic" | "audio" | "responses";
  state: "running" | "completed";
  responseStatus?: number;
  responseTimeMs?: number;
  elapsedMs: number;
  isStreaming: boolean;
  enforceMode: boolean;
  retryCount: number;
  errorMessage?: string;
  errorType?: string;
  promptTokens?: number;
  promptTokensEstimated?: boolean;
  completionTokens?: number;
  completionTokensEstimated?: boolean;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cachedTokens?: number;
  matchedTokens?: number;
  isCacheHit?: boolean;
  msSinceLastMatch?: number;
  userCostUsd?: number;
  typicalCostUsd?: number;
  savedCostUsd?: number;
  streamChunkCount?: number;
  streamBytes?: number;
}

export interface ObservabilityFilters {
  provider?: string;
  model?: string;
  apiKeyEnvVar?: string;
  status?: "ok" | "error" | "running";
  state?: "running" | "completed";
  cacheHit?: boolean;
  since?: string;
  until?: string;
  search?: string;
}

export interface AnalyticsSummary {
  totalRequests: number;
  completedRequests: number;
  failedRequests: number;
  activeRequests: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  matchedTokens: number;
  cacheHits: number;
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  avgTokensPerSecond?: number;
  byProviderKey: Array<{
    provider: string;
    apiKeyEnvVar: string;
    model: string;
    requests: number;
    totalTokens: number;
    userCostUsd: number;
    typicalCostUsd: number;
    savedCostUsd: number;
    cacheHits: number;
  }>;
}

export interface UserLimits {
  requestsPerMinute?: number;
  requestsPerDay?: number;
  tokensPerDay?: number;
  costUsdPerDay?: number;
  concurrentRequests?: number;
}

export interface AvailableModel {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
  context_window?: number;
  context_length?: number;
  limit?: { context?: number };
}

export interface ModelListItem {
  logical_name: string;
  path: string;
  modified_at: string;
}

export interface ProviderListItem {
  name: string;
  path: string;
  modified_at: string;
  enabled: boolean;
}

export interface EnvEntry {
  key: string;
  value: string;
  masked: boolean;
}

// -------- Health --------
export function getHealth(signal?: AbortSignal): Promise<HealthDetailed> {
  return apiFetch<HealthDetailed>(
    "/health/detailed",
    signal !== undefined ? { signal } : {},
  );
}

// -------- Auth --------
export function authConfig(): Promise<{
  clerk_configured: boolean;
  clerk_publishable_key?: string;
}> {
  return apiFetch("/v1/auth/config");
}

export async function login(apiKey: string): Promise<void> {
  await apiFetch("/v1/admin/auth/login", {
    method: "POST",
    body: { api_key: apiKey },
  });
}

export async function logout(): Promise<void> {
  await apiFetch("/v1/admin/auth/logout", { method: "POST" });
}

export async function authStatus(): Promise<{
  authenticated: boolean;
  reason?: string;
  header_authenticated?: boolean;
  session_authenticated?: boolean;
  clerk_authenticated?: boolean;
  clerk_configured?: boolean;
  clerk_publishable_key?: string;
}> {
  return apiFetch<{
    authenticated: boolean;
    reason?: string;
    header_authenticated?: boolean;
    session_authenticated?: boolean;
    clerk_authenticated?: boolean;
    clerk_configured?: boolean;
    clerk_publishable_key?: string;
  }>("/v1/admin/auth/status");
}

// -------- Observability --------
export async function getLogs(limit = 100, offset = 0, filters: ObservabilityFilters = {}): Promise<{
  count: number;
  limit: number;
  offset: number;
  total: number;
  records: RequestLogRecord[];
  total_completed: number;
  total_in_buffer: number;
  active_count: number;
  has_more: boolean;
  filters_applied?: ObservabilityFilters;
}> {
  return apiFetch(`/v1/admin/logs?${observabilityQuery({ limit, offset, filters })}`);
}

export interface AnalyticsTimeseriesPoint {
  bucket: string;
  requests: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  userCostUsd: number;
  typicalCostUsd: number;
  savedCostUsd: number;
}

export interface AnalyticsTimeseriesResponse {
  bucket: "hour" | "day";
  filters_applied: ObservabilityFilters;
  points: AnalyticsTimeseriesPoint[];
}

export function getAnalytics(filters: ObservabilityFilters = {}): Promise<{
  filters_applied: ObservabilityFilters;
  summary: AnalyticsSummary;
}> {
  return apiFetch(`/v1/admin/analytics?${observabilityQuery({ filters })}`);
}

export function getAnalyticsTimeseries(
  filters: ObservabilityFilters = {},
  bucket: "hour" | "day" = "hour",
): Promise<AnalyticsTimeseriesResponse> {
  return apiFetch(`/v1/admin/analytics/timeseries?${observabilityQuery({ filters, extra: { bucket } })}`);
}

export function getAnalyticsPricing(): Promise<{ pricing: Record<string, unknown> }> {
  return apiFetch("/v1/admin/analytics/pricing");
}

export function saveAnalyticsPricing(pricing: Record<string, unknown>): Promise<{ pricing: Record<string, unknown> }> {
  return apiFetch("/v1/admin/analytics/pricing", { method: "PUT", body: pricing });
}

export function getStoredCompletion(requestId: string): Promise<{ completion: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/storage/completions/${encodeURIComponent(requestId)}`);
}

function observabilityQuery({
  limit,
  offset,
  filters = {},
  extra = {},
}: {
  limit?: number;
  offset?: number;
  filters?: ObservabilityFilters;
  extra?: Record<string, string>;
}): string {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set("limit", String(limit));
  if (offset !== undefined) params.set("offset", String(offset));
  if (filters.provider !== undefined) params.set("provider", filters.provider);
  if (filters.model !== undefined) params.set("model", filters.model);
  if (filters.apiKeyEnvVar !== undefined) params.set("api_key_env", filters.apiKeyEnvVar);
  if (filters.status !== undefined) params.set("status", filters.status);
  if (filters.state !== undefined) params.set("state", filters.state);
  if (filters.cacheHit !== undefined) params.set("cache_hit", String(filters.cacheHit));
  if (filters.since !== undefined) params.set("since", filters.since);
  if (filters.until !== undefined) params.set("until", filters.until);
  if (filters.search !== undefined) params.set("search", filters.search);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

// -------- Models --------
export async function listModels(): Promise<{ models: ModelListItem[] }> {
  return apiFetch("/v1/admin/config/models");
}

export async function listAvailableModels(): Promise<{ object: "list"; data: AvailableModel[] }> {
  return apiFetch("/v1/models");
}

export async function getModel(name: string): Promise<{ model: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/config/models/${encodeURIComponent(name)}`);
}

export async function saveModel(
  name: string,
  config: Record<string, unknown>,
): Promise<{ model: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/config/models/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: config,
  });
}

export async function createModel(
  name: string,
  config: Record<string, unknown>,
): Promise<{ model: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/config/models/${encodeURIComponent(name)}`, {
    method: "POST",
    body: config,
  });
}

export async function deleteModel(name: string): Promise<void> {
  await apiFetch(`/v1/admin/config/models/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

// -------- Providers --------
export async function listProviders(): Promise<{ providers: ProviderListItem[] }> {
  return apiFetch("/v1/admin/config/providers");
}

export async function getProvider(name: string): Promise<{ provider: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/config/providers/${encodeURIComponent(name)}`);
}

export async function saveProvider(
  name: string,
  config: Record<string, unknown>,
): Promise<{ provider: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/config/providers/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: config,
  });
}

export async function deleteProvider(name: string): Promise<void> {
  await apiFetch(`/v1/admin/config/providers/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
}

// -------- Env --------
export async function getEnv(reveal = false): Promise<{ entries: EnvEntry[]; path: string }> {
  return apiFetch(`/v1/admin/config/env${reveal ? "?reveal=true" : ""}`);
}

export async function saveEnv(entries: Array<{ key: string; value: string }>): Promise<{
  applied: number;
  skipped: string[];
  path: string;
}> {
  return apiFetch("/v1/admin/config/env", {
    method: "PUT",
    body: { entries },
  });
}

// -------- Multi-user --------
export interface PrincipalInfo {
  userId?: string;
  apiKeyId?: string;
  email?: string;
  role: "owner" | "admin" | "user";
  isOwner: boolean;
  ownerBypass: boolean;
  completionLoggingEnabled: boolean;
}

export interface UserRecord {
  id: string;
  email: string;
  role: "owner" | "admin" | "user";
  status: "active" | "disabled";
  completionLoggingEnabled: boolean;
  createdAt: string;
  lastLoginAt?: string;
}

export interface SignupSettings {
  multiUserEnabled: boolean;
  openSignupEnabled: boolean;
  inviteSignupEnabled: boolean;
  allowUserKeyCreation: boolean;
  allowUserCompletionLogging: boolean;
  defaultLimits: Record<string, unknown>;
  inviteLimits: Record<string, unknown>;
}

export interface InviteRecord {
  id: string;
  email?: string;
  expiresAt: string;
  usedByUserId?: string;
  usedAt?: string;
  revokedAt?: string;
  createdAt: string;
}

export function getMe(): Promise<{ principal: PrincipalInfo; signup: SignupSettings; owner_user_exists: boolean }> {
  return apiFetch("/v1/auth/me");
}

export function getCurrentUserLimits(): Promise<{ limits: UserLimits }> {
  return apiFetch("/v1/user/limits");
}

export function getCurrentUserAnalytics(filters: ObservabilityFilters = {}): Promise<{
  filters_applied: ObservabilityFilters & { userId?: string };
  summary: AnalyticsSummary;
}> {
  return apiFetch(`/v1/user/analytics?${observabilityQuery({ filters })}`);
}

export function getCurrentUserAnalyticsTimeseries(
  filters: ObservabilityFilters = {},
  bucket: "hour" | "day" = "hour",
): Promise<AnalyticsTimeseriesResponse> {
  return apiFetch(`/v1/user/analytics/timeseries?${observabilityQuery({ filters, extra: { bucket } })}`);
}

export function listUsersAdmin(): Promise<{ users: UserRecord[] }> {
  return apiFetch("/v1/admin/users");
}

export function getUserEntitlements(userId: string): Promise<{ entitlements: Array<Record<string, unknown>> }> {
  return apiFetch(`/v1/admin/users/${encodeURIComponent(userId)}/entitlements`);
}

export function saveUserEntitlements(userId: string, entitlements: Array<Record<string, unknown>>): Promise<{ entitlements: Array<Record<string, unknown>> }> {
  return apiFetch(`/v1/admin/users/${encodeURIComponent(userId)}/entitlements`, {
    method: "PUT",
    body: { entitlements },
  });
}

export function getUserLimits(userId: string): Promise<{ limits: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/users/${encodeURIComponent(userId)}/limits`);
}

export function saveUserLimits(userId: string, limits: Record<string, unknown>): Promise<{ limits: Record<string, unknown> }> {
  return apiFetch(`/v1/admin/users/${encodeURIComponent(userId)}/limits`, {
    method: "PUT",
    body: limits,
  });
}

export function listInvitesAdmin(): Promise<{ invites: InviteRecord[] }> {
  return apiFetch("/v1/admin/invites");
}

export function createInviteAdmin(input: Record<string, unknown>): Promise<{ invite: InviteRecord; token: string }> {
  return apiFetch("/v1/admin/invites", { method: "POST", body: input });
}

export function getSignupSettingsAdmin(): Promise<{ signup: SignupSettings }> {
  return apiFetch("/v1/admin/signup-settings");
}

export function saveSignupSettingsAdmin(input: Record<string, unknown>): Promise<{ signup: SignupSettings }> {
  return apiFetch("/v1/admin/signup-settings", { method: "PUT", body: input });
}

export function createUserApiKey(label: string): Promise<{ api_key: { id: string; key: string; keyPrefix: string; keyLastFour: string } }> {
  return apiFetch("/v1/user/api-keys", { method: "POST", body: { label } });
}

// -------- Provider subscription accounts --------
export interface ProviderAccountRecord {
  id: string;
  provider: string;
  kind: "oauth" | "token";
  label: string;
  email?: string;
  account_id?: string;
  plan?: string;
  owner_user_id?: string;
  shared: boolean;
  status: "active" | "error" | "disabled";
  last_error?: string;
  last_used_at?: string;
  last_refreshed_at?: string;
  expires_at?: string;
  created_at: string;
  can_manage: boolean;
  can_use: boolean;
}

export interface DeviceFlowRecord {
  id: string;
  user_code: string;
  verification_url: string;
  interval_ms: number;
  expires_at: string;
}

export function listProviderAccounts(): Promise<{ accounts: ProviderAccountRecord[] }> {
  return apiFetch("/v1/accounts");
}

export function getProviderAccountsStatus(): Promise<{
  convex: {
    configured: boolean;
    syncing: boolean;
    lastSyncedAt?: string;
    lastError?: string;
    accountCount: number;
  };
  credential_encryption: string;
}> {
  return apiFetch("/v1/accounts/status");
}

export function startCodexOAuth(shared: boolean): Promise<{
  flow: { id: string; authorize_url: string; expires_at: string; callback_uri: string };
}> {
  return apiFetch("/v1/accounts/codex/oauth/start", {
    method: "POST",
    body: { shared },
  });
}

export function completeCodexOAuth(callbackUrl: string): Promise<{
  account: ProviderAccountRecord;
}> {
  return apiFetch("/v1/accounts/codex/oauth/complete", {
    method: "POST",
    body: { callback_url: callbackUrl },
  });
}

export function startAccountDeviceFlow(
  provider: "codex" | "supergrok",
  shared: boolean,
): Promise<{ flow: DeviceFlowRecord }> {
  return apiFetch(`/v1/accounts/${provider}/device/start`, {
    method: "POST",
    body: { shared },
  });
}

export function pollAccountDeviceFlow(
  provider: "codex" | "supergrok",
  flowId: string,
): Promise<{ account: ProviderAccountRecord }> {
  return apiFetch(`/v1/accounts/${provider}/device/${encodeURIComponent(flowId)}/poll`, {
    method: "POST",
  });
}

export function importLocalCodexAccount(): Promise<{ account: ProviderAccountRecord }> {
  return apiFetch("/v1/accounts/codex/import-local", { method: "POST" });
}

export function attachProviderToken(input: {
  provider: string;
  label?: string;
  email?: string;
  access_token: string;
  shared: boolean;
}): Promise<{ account: ProviderAccountRecord }> {
  return apiFetch("/v1/accounts/token", { method: "POST", body: input });
}

export function updateProviderAccount(
  accountId: string,
  patch: { label?: string; shared?: boolean; status?: string },
): Promise<{ account: ProviderAccountRecord }> {
  return apiFetch(`/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function refreshProviderAccount(
  accountId: string,
): Promise<{ account: ProviderAccountRecord }> {
  return apiFetch(`/v1/accounts/${encodeURIComponent(accountId)}/refresh`, {
    method: "POST",
  });
}

export async function removeProviderAccount(accountId: string): Promise<void> {
  await apiFetch(`/v1/accounts/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
  });
}


// -------- Proxies --------
export interface ProxyProviderStatus {
  provider: string;
  enabled: boolean;
  proxyCount: number;
  proxies: string[];
}

export interface ProxyDiscoveryReport {
  targetCount: number;
  providers: string[];
  candidatesFetched: number;
  candidatesTested: number;
  accepted: Array<{ url: string }>;
  rejectedByProvider: Record<string, number>;
  skippedProviders: Record<string, string>;
  persisted?: { path: string; applied: number; removed: string[] };
}

export interface ProxyDiscoveryProgress {
  targetCount: number;
  providers: string[];
  candidatesFetched: number;
  candidatesTested: number;
  accepted: number;
  rejectedByProvider: Record<string, number>;
  skippedProviders: Record<string, string>;
}

export interface ProxyDiscoveryJob {
  id: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  error?: string;
  progress?: ProxyDiscoveryProgress;
  report?: ProxyDiscoveryReport;
}

export async function getProxyStatus(): Promise<{
  status: { shared: string[]; providers: ProxyProviderStatus[] };
  last_discovery?: ProxyDiscoveryReport;
  discovery_job?: ProxyDiscoveryJob;
}> {
  return apiFetch("/v1/admin/proxies");
}

export async function discoverProxies(options: {
  target_count?: number;
  providers?: string[];
  persist?: boolean;
  timeout_ms?: number;
  concurrency?: number;
  source_limit?: number;
}): Promise<{ job: ProxyDiscoveryJob }> {
  return apiFetch("/v1/admin/proxies/discover", { method: "POST", body: options });
}
