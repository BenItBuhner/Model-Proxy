import { z } from "zod";
import { EnforceToolCallConfigSchema } from "./enforce.ts";

/**
 * Configuration for a single provider route inside a ModelRoutingConfig.
 * Mirrors `app/routing/models.py::RouteConfig`.
 */
export const RouteConfigSchema = z
  .object({
    wire_protocol: z.enum(["openai", "anthropic"]).optional(),
    provider: z.string().min(1),
    model: z.string().min(1),
    base_url: z.string().url().optional(),
    api_key_env: z.array(z.string().min(1)).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    cooldown_seconds: z.number().int().nonnegative().optional(),
  })
  .strict();

export type RouteConfig = z.infer<typeof RouteConfigSchema>;

/**
 * Configuration for a single logical model.
 * Mirrors `app/routing/models.py::ModelRoutingConfig` with the new
 * `enforce_tool_call` field added for per-model validation control.
 */
export const ModelRoutingConfigSchema = z
  .object({
    logical_name: z.string().min(1),
    timeout_seconds: z.number().int().positive().default(60),
    default_cooldown_seconds: z.number().int().nonnegative().default(180),
    enforce_tool_call: EnforceToolCallConfigSchema.optional(),
    model_routings: z.array(RouteConfigSchema).min(1),
    fallback_model_routings: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;

/**
 * A concrete route resolved from a logical model config with credentials + URL baked in.
 */
export interface ResolvedRoute {
  sourceLogicalModel: string;
  wireProtocol: "openai" | "anthropic";
  provider: string;
  model: string;
  baseUrl: string | undefined;
  apiKey: string;
  apiKeyEnvVar: string;
  timeoutSeconds: number;
  cooldownSeconds: number;
}

export interface Attempt {
  route: ResolvedRoute;
  attemptNumber: number;
  isFallbackRoute: boolean;
}

export interface AttemptResult {
  attempt: Attempt;
  success: boolean;
  response: unknown;
  error: string | undefined;
  errorType: string | undefined;
  statusCode: number | undefined;
  durationMs: number | undefined;
}

/** Custom error thrown when every route has been exhausted. */
export class RoutingError extends Error {
  readonly logicalModel: string;
  readonly attemptedRoutes: Attempt[];
  readonly errors: Array<Record<string, unknown>>;

  constructor(
    logicalModel: string,
    attemptedRoutes: Attempt[],
    errors: Array<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "RoutingError";
    this.logicalModel = logicalModel;
    this.attemptedRoutes = attemptedRoutes;
    this.errors = errors;
  }

  summary(): string {
    return (
      `All ${this.attemptedRoutes.length} routes failed for ` +
      `'${this.logicalModel}' with ${this.errors.length} error(s)`
    );
  }

  toJSON(): Record<string, unknown> {
    return {
      logical_model: this.logicalModel,
      attempted_routes_count: this.attemptedRoutes.length,
      errors: this.errors,
      message: this.message,
    };
  }
}
