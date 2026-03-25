/**
 * Provider JSON configuration type definitions (Zod schemas).
 * Maps to config/providers/<provider>.json file format.
 */
import { z } from "zod";

export const ApiKeysConfigSchema = z.object({
  env_var_pattern: z.string().optional(),
  env_var_patterns: z.array(z.string()).default([]),
  description: z.string().optional(),
});

export const EndpointsConfigSchema = z.object({
  base_url: z.string(),
  completions: z.string().optional(),
  streaming: z.string().optional(),
  compatible_format: z.string().optional(),
});

export const AuthConfigSchema = z.object({
  type: z.string().optional(),
  header_name: z.string(),
  header_format: z.string().default("{api_key}"),
  additional_headers: z.record(z.string()).optional(),
});

export const RequestConfigSchema = z.object({
  timeout_seconds: z.number().default(60),
  max_retries: z.number().default(3),
  retry_on_status: z.array(z.number()).optional(),
  default_parameters: z.record(z.any()).optional(),
  required_parameters: z.array(z.string()).optional(),
});

export const RateLimitingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  requests_per_minute: z.number().nullable().optional(),
  tokens_per_minute: z.number().nullable().optional(),
  cooldown_seconds: z.number().default(180),
});

export const ErrorActionSchema = z.object({
  action: z.string(),
  cooldown_seconds: z.number().optional(),
});

export const ProxySupportSchema = z.object({
  enabled: z.boolean().default(false),
  base_url_override: z.string().nullable().optional(),
  description: z.string().optional(),
});

export const ProviderConfigSchema = z.object({
  name: z.string(),
  display_name: z.string().optional(),
  enabled: z.boolean().default(true),
  api_keys: ApiKeysConfigSchema.optional(),
  endpoints: EndpointsConfigSchema,
  authentication: AuthConfigSchema,
  request_config: RequestConfigSchema.optional(),
  rate_limiting: RateLimitingConfigSchema.optional(),
  models: z.record(z.any()).optional(),
  error_handling: z.record(ErrorActionSchema).optional(),
  proxy_support: ProxySupportSchema.optional(),
  model_mapping: z.record(z.string()).optional(),
  provider_notes: z.record(z.any()).optional(),
});

// ── Inferred Types ────────────────────────────────────────────────
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type EndpointsConfig = z.infer<typeof EndpointsConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ErrorAction = z.infer<typeof ErrorActionSchema>;
