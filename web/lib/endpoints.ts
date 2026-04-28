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
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedProvider?: string;
  resolvedModel?: string;
  wireProtocol?: "openai" | "anthropic" | "audio";
  responseStatus?: number;
  responseTimeMs?: number;
  isStreaming: boolean;
  enforceMode: boolean;
  retryCount: number;
  errorMessage?: string;
  errorType?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
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
}> {
  return apiFetch<{
    authenticated: boolean;
    reason?: string;
    header_authenticated?: boolean;
    session_authenticated?: boolean;
  }>("/v1/admin/auth/status");
}

// -------- Logs --------
export async function getLogs(limit = 100): Promise<{ records: RequestLogRecord[]; total_in_buffer: number }> {
  return apiFetch(`/v1/admin/logs?limit=${limit}`);
}

// -------- Models --------
export async function listModels(): Promise<{ models: ModelListItem[] }> {
  return apiFetch("/v1/admin/config/models");
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
