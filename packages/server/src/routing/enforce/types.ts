import type { ResolvedEnforceConfig } from "@model-proxy/contracts/schemas/enforce.ts";

export type EnforceProtocol = "openai" | "anthropic";

export type ValidationResponseKind = "tool_calls" | "termination" | "invalid";

export interface ValidationResult {
  valid: boolean;
  reason: string;
  responseType: ValidationResponseKind;
}

export type { ResolvedEnforceConfig };
