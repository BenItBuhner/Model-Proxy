/**
 * Sandbox types for code execution environments.
 * These define the interface between the Fusion subagent system
 * and the code execution sandbox (currently stubbed with Bun.subprocess,
 * swappable for a real WASM runtime like wasmtime later).
 */

// ── Supported Languages ──────────────────────────────────────────────

export type CodeLanguage = "python" | "javascript" | "typescript";

// ── Execution Request ────────────────────────────────────────────────

export interface CodeExecutionRequest {
  /** The raw source code to execute. */
  code: string;
  /** The language of the code. */
  language: CodeLanguage;
  /** Optional timeout in milliseconds (default: 30000). */
  timeoutMs?: number;
  /** Optional memory limit in MB (default: 256). */
  memoryMb?: number;
}

// ── Execution Result ─────────────────────────────────────────────────

export interface CodeExecutionResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Execution duration in milliseconds. */
  durationMs: number;
  /** Error message if execution failed catastrophically. */
  error?: string;
}

// ── Fetch Shim Config ────────────────────────────────────────────────

export interface FetchShimConfig {
  /** Whether to allow outbound HTTP requests. */
  allowNetwork: boolean;
  /** Optional domain allow-list (empty = all allowed if allowNetwork is true). */
  allowedDomains?: string[];
  /** Maximum response body size in bytes. */
  maxResponseBytes: number;
  /** Request timeout in milliseconds. */
  timeoutMs: number;
}
