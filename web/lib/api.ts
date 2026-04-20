"use client";

const STORAGE_KEY = "mp_api_key";

function getBaseUrl(): string {
  if (typeof window === "undefined") return "";
  const raw = window.location.origin;
  return raw;
}

export function getStoredApiKey(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value === null || value.length === 0) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export function setStoredApiKey(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // ignore
  }
}

export function clearStoredApiKey(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export interface ApiError {
  status: number;
  message: string;
  body: unknown;
}

export class ApiException extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(error: ApiError) {
    super(error.message);
    this.status = error.status;
    this.body = error.body;
  }
}

export interface ApiOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export async function apiFetch<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const key = getStoredApiKey();
  const init: RequestInit = {
    method: options.method ?? "GET",
    credentials: "include",
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(key !== undefined ? { Authorization: `Bearer ${key}` } : {}),
      ...(options.headers ?? {}),
    },
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);
  if (options.signal !== undefined) init.signal = options.signal;

  const res = await fetch(`${getBaseUrl()}${path}`, init);
  const text = await res.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed
        ? extractErrorMessage((parsed as Record<string, unknown>)["error"])
        : res.statusText;
    throw new ApiException({
      status: res.status,
      message: typeof message === "string" ? message : `HTTP ${res.status}`,
      body: parsed,
    });
  }

  return parsed as T;
}

function extractErrorMessage(input: unknown): string {
  if (typeof input === "string") return input;
  if (
    typeof input === "object" &&
    input !== null &&
    "message" in (input as Record<string, unknown>) &&
    typeof (input as Record<string, unknown>).message === "string"
  ) {
    return (input as { message: string }).message;
  }
  return "Request failed";
}
