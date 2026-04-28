import { z } from "zod";

const EnvSubstitutedUrlSchema = z.string().min(1).refine(
  (value) => value.includes("${") || z.string().url().safeParse(value).success,
  "Expected a valid URL or an environment-substituted URL like ${PROVIDER_BASE_URL}.",
);

/**
 * Schema for `config/providers/<name>.json` files. Mirrors the structure used
 * by the Python implementation (`app/core/provider_config.py` +
 * `app/providers/*`).
 */

export const ApiKeyPatternSchema = z
  .object({
    env_var_pattern: z.string().optional(),
    env_var_patterns: z.array(z.string().min(1)).default([]),
    description: z.string().optional(),
  })
  .passthrough();

export const EndpointsSchema = z
  .object({
    base_url: EnvSubstitutedUrlSchema,
    completions: z.string().min(1),
    streaming: z.string().min(1).optional(),
    audio_transcriptions: z.string().min(1).optional(),
    audio_translations: z.string().min(1).optional(),
    audio_streaming: z.string().min(1).optional(),
    // "azure" is a Python-era alias; GitHub Models / Azure endpoints behave
    // as OpenAI-compatible at the wire level in this runtime.
    compatible_format: z
      .enum(["openai", "anthropic", "azure"])
      .default("openai"),
  })
  .passthrough();

export const AuthenticationSchema = z
  .object({
    // "api_key" / "azure_key" are Python-era aliases for bearer-style auth.
    // They are kept in the enum to preserve bundle fidelity; the runtime
    // providers treat them identically to "bearer".
    type: z.enum([
      "bearer",
      "x-api-key",
      "api-key-header",
      "none",
      "api_key",
      "azure_key",
    ]),
    header_name: z.string().min(1).optional(),
    header_format: z.string().optional(),
    additional_headers: z.record(z.string()).optional(),
  })
  .passthrough();

export const RequestConfigSchema = z
  .object({
    timeout_seconds: z.number().int().positive().default(60),
    max_retries: z.number().int().nonnegative().default(0),
    retry_on_status: z.array(z.number().int()).default([]),
    default_parameters: z.record(z.unknown()).default({}),
    required_parameters: z.array(z.string()).default([]),
  })
  .passthrough();

export const RateLimitingSchema = z
  .object({
    enabled: z.boolean().default(false),
    requests_per_minute: z.number().int().positive().nullable().optional(),
    tokens_per_minute: z.number().int().positive().nullable().optional(),
    cooldown_seconds: z.number().int().nonnegative().default(180),
  })
  .passthrough();

export const ErrorActionSchema = z
  .object({
    // "ignore" and "cooldown" are Python-era values; the normalizer maps
    // them to "pass_through" and "provider_cooldown" respectively, but the
    // enum accepts them so raw bundles round-trip without loss.
    action: z.enum([
      "global_key_failure",
      "model_key_failure",
      "route_failure",
      "provider_cooldown",
      "fallback_no_cooldown",
      "auto_fix_tool_responses",
      "retry",
      "pass_through",
      "ignore",
      "cooldown",
    ]),
  })
  .passthrough();

export const ProviderConfigSchema = z
  .object({
    name: z.string().min(1),
    display_name: z.string().optional(),
    enabled: z.boolean().default(true),
    api_keys: ApiKeyPatternSchema,
    endpoints: EndpointsSchema,
    authentication: AuthenticationSchema,
    request_config: RequestConfigSchema.default({}),
    rate_limiting: RateLimitingSchema.default({}),
    models: z.record(z.unknown()).default({}),
    error_handling: z.record(ErrorActionSchema).default({}),
    proxy_support: z
      .object({
        enabled: z.boolean().default(false),
        base_url_override: EnvSubstitutedUrlSchema.nullable().optional(),
        description: z.string().optional(),
      })
      .passthrough()
      .optional(),
    model_mapping: z.record(z.string()).default({}),
  })
  .passthrough();

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type EndpointConfig = z.infer<typeof EndpointsSchema>;
export type AuthenticationConfig = z.infer<typeof AuthenticationSchema>;
