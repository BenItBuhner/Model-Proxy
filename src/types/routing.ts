/**
 * Routing configuration type definitions (Zod schemas).
 * Maps to config/models/<logical_model>.json file format.
 */
import { z } from "zod";

export const WireProtocolSchema = z.enum(["openai", "anthropic"]);
export type WireProtocol = z.infer<typeof WireProtocolSchema>;

// ── Route Config ──────────────────────────────────────────────────
export const RouteConfigSchema = z.object({
  wire_protocol: WireProtocolSchema.optional(),
  provider: z.string(),
  model: z.string(),
  base_url: z.string().optional(),
  api_key_env: z.array(z.string()).optional(),
  timeout_seconds: z.number().int().optional(),
  cooldown_seconds: z.number().int().optional(),
});

// ── Model Routing Config ──────────────────────────────────────────
export const ModelRoutingConfigSchema = z.object({
  logical_name: z.string(),
  timeout_seconds: z.number().int().optional().default(60),
  default_cooldown_seconds: z.number().int().default(180),
  model_routings: z.array(RouteConfigSchema),
  fallback_model_routings: z.array(z.string()).default([]),
});

// ── Resolved Route ────────────────────────────────────────────────
export const ResolvedRouteSchema = z.object({
  sourceLogicalModel: z.string(),
  wireProtocol: WireProtocolSchema,
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string(),
  timeoutSeconds: z.number().int(),
});

// ── Attempt ───────────────────────────────────────────────────────
export const AttemptSchema = z.object({
  route: ResolvedRouteSchema,
  attemptNumber: z.number().int(),
  isFallbackRoute: z.boolean().default(false),
});

// ── Inferred Types ────────────────────────────────────────────────
export type RouteConfig = z.infer<typeof RouteConfigSchema>;
export type ModelRoutingConfig = z.infer<typeof ModelRoutingConfigSchema>;
export type ResolvedRoute = z.infer<typeof ResolvedRouteSchema>;
export type Attempt = z.infer<typeof AttemptSchema>;

// ── Routing Error ─────────────────────────────────────────────────
export class RoutingError extends Error {
  logicalModel: string;
  attemptedRoutes: Attempt[];
  errors: Array<Record<string, unknown>>;

  constructor(opts: {
    logicalModel: string;
    attemptedRoutes: Attempt[];
    errors: Array<Record<string, unknown>>;
    message: string;
  }) {
    super(opts.message);
    this.name = "RoutingError";
    this.logicalModel = opts.logicalModel;
    this.attemptedRoutes = opts.attemptedRoutes;
    this.errors = opts.errors;
  }

  getErrorSummary(): string {
    return (
      `All ${this.attemptedRoutes.length} routes failed for '${this.logicalModel}' ` +
      `with ${this.errors.length} error(s)`
    );
  }

  toDict(): Record<string, unknown> {
    return {
      logical_model: this.logicalModel,
      attempted_routes_count: this.attemptedRoutes.length,
      errors: this.errors,
      message: this.message,
    };
  }
}
