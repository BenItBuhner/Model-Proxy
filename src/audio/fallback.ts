import {
  AudioRoutingError,
  type AudioModelRoutingConfig,
  type AudioRouteConfig,
  type ResolvedAudioRoute,
} from "../../shared/schemas/audio-routing.ts";
import type { AudioTranscriptionRequest } from "../../shared/schemas/audio-wire.ts";
import { audioModelConfigLoader } from "../config/audio-model-loader.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { currentRequestId, emit, nowIso } from "../observability/request-context.ts";
import {
  KeyCycleTracker,
  type ErrorAction,
} from "../providers/api-key-manager.ts";
import { createLogger } from "../observability/logger.ts";
import {
  type AudioProviderResponse,
  AudioProviderCapabilityError,
  AudioProviderUpstreamError,
} from "./base.ts";
import { getAudioProviderAdapter } from "./registry.ts";
import { recordRequestProgress } from "../server/request-log.ts";

const log = createLogger("audio.fallback");

function recordAudioRouteProgress(route: ResolvedAudioRoute, attempt: number): void {
  const requestId = currentRequestId();
  if (requestId === undefined) return;
  recordRequestProgress({
    requestId,
    resolvedProvider: route.provider,
    resolvedModel: route.model,
    apiKeyEnvVar: route.apiKeyEnvVar,
    keyHint: keyHint(route.apiKey),
    retryCount: Math.max(0, attempt - 1),
  });
}

interface RouteTuple {
  routeConfig: AudioRouteConfig;
  isFallback: boolean;
  sourceModel: string;
}

export interface AudioFallbackArgs {
  logicalModel: string;
  request: AudioTranscriptionRequest;
  formData: FormData;
  file: File | Blob | undefined;
  maxKeyCycles?: number;
  signal?: AbortSignal;
}

export class AudioFallbackRouter {
  private visited = new Set<string>();
  private configCache = new Map<string, AudioModelRoutingConfig>();

  async transcribeWithFallback(args: AudioFallbackArgs): Promise<AudioProviderResponse> {
    const routes = this.collectRouteConfigs(args.logicalModel);
    if (routes.length === 0) {
      throw new AudioRoutingError(args.logicalModel, [], "No audio route configured.");
    }

    const errors: Array<Record<string, unknown>> = [];
    let attempt = 0;
    for (const tuple of routes) {
      const modelConfig = this.getModelConfig(tuple.sourceModel);
      const tracker = this.createTracker(tuple.routeConfig, modelConfig, args.maxKeyCycles);
      let keyInfo = this.resolveApiKey(tuple.routeConfig, tracker);
      while (keyInfo !== undefined) {
        attempt += 1;
        const route = this.buildResolvedRoute(
          tuple.routeConfig,
          tuple.sourceModel,
          keyInfo.apiKey,
          keyInfo.envVar,
          modelConfig,
        );
        recordAudioRouteProgress(route, attempt);
        const started = Date.now();
        emit({
          type: "route.attempted",
          at: nowIso(),
          attempt,
          provider: route.provider,
          model: route.model,
          wireProtocol: "audio",
          isFallback: tuple.isFallback,
          keyHint: keyHint(route.apiKey),
        });

        try {
          const adapter = getAudioProviderAdapter(route.format);
          const response = await adapter.transcribe({
            route,
            request: args.request,
            formData: args.formData,
            file: args.file,
            signal: args.signal,
          });
          emit({
            type: "route.succeeded",
            at: nowIso(),
            attempt,
            provider: route.provider,
            model: route.model,
            latencyMs: Date.now() - started,
          });
          return response;
        } catch (err) {
          const status = extractStatusCode(err);
          const willFallback = !(err instanceof AudioProviderCapabilityError);
          emit({
            type: "route.failed",
            at: nowIso(),
            attempt,
            provider: route.provider,
            model: route.model,
            status,
            errorType: err instanceof Error ? err.name : "Error",
            message: err instanceof Error ? err.message : String(err),
            willFallback,
          });
          errors.push({
            provider: route.provider,
            model: route.model,
            status,
            error: err instanceof Error ? err.message : String(err),
          });

          if (!willFallback) break;
          const action = resolveErrorAction(route.provider, status);
          if (action.action !== "pass_through") {
            tracker.markFailed(route.apiKey, {
              action: action.action,
              cooldownSeconds: action.cooldownSeconds,
            });
            emit({
              type: "key.cooldown",
              at: nowIso(),
              provider: route.provider,
              model: route.model,
              action: action.action,
              cooldownSeconds: action.cooldownSeconds,
            });
          }
          if (route.apiKeyEnvVar === "(none)") {
            break;
          }
          keyInfo = this.resolveApiKey(tuple.routeConfig, tracker);
        }
      }
    }

    log.warn("all audio routes failed", { logicalModel: args.logicalModel, errors });
    throw new AudioRoutingError(
      args.logicalModel,
      errors,
      `All audio routes failed for '${args.logicalModel}'.`,
    );
  }

  collectRouteConfigs(logicalModel: string): RouteTuple[] {
    this.visited.clear();
    return this.collectRouteConfigsRecursive(logicalModel, false);
  }

  private collectRouteConfigsRecursive(
    logicalModel: string,
    isFallback: boolean,
  ): RouteTuple[] {
    if (this.visited.has(logicalModel)) return [];
    this.visited.add(logicalModel);
    let config: AudioModelRoutingConfig;
    try {
      config = this.getModelConfig(logicalModel);
    } catch (err) {
      log.warn("failed to load audio config", { logicalModel, err: String(err) });
      this.visited.delete(logicalModel);
      return [];
    }
    const out: RouteTuple[] = config.audio_routings.map((routeConfig) => ({
      routeConfig,
      isFallback,
      sourceModel: logicalModel,
    }));
    for (const fallback of config.fallback_audio_routings) {
      out.push(...this.collectRouteConfigsRecursive(fallback, true));
    }
    this.visited.delete(logicalModel);
    return out;
  }

  private getModelConfig(logicalModel: string): AudioModelRoutingConfig {
    const cached = this.configCache.get(logicalModel);
    if (cached !== undefined) return cached;
    const config = audioModelConfigLoader.loadConfig(logicalModel);
    this.configCache.set(logicalModel, config);
    return config;
  }

  private createTracker(
    routeConfig: AudioRouteConfig,
    modelConfig: AudioModelRoutingConfig,
    maxKeyCycles: number | undefined,
  ): KeyCycleTracker {
    const options: ConstructorParameters<typeof KeyCycleTracker>[0] = {
      provider: routeConfig.provider,
      model: routeConfig.model,
      routeCooldownSeconds:
        routeConfig.cooldown_seconds ?? modelConfig.default_cooldown_seconds,
    };
    if (maxKeyCycles !== undefined) options.maxCycles = maxKeyCycles;
    try {
      options.providerCooldownSeconds = providerConfigLoader.loadProvider(
        routeConfig.provider,
      ).rate_limiting.cooldown_seconds;
    } catch {
      // leave default
    }
    return new KeyCycleTracker(options);
  }

  private buildResolvedRoute(
    routeConfig: AudioRouteConfig,
    sourceLogicalModel: string,
    apiKey: string,
    apiKeyEnvVar: string,
    modelConfig: AudioModelRoutingConfig,
  ): ResolvedAudioRoute {
    return {
      sourceLogicalModel,
      provider: routeConfig.provider,
      model: routeConfig.model,
      format: routeConfig.format,
      baseUrl: routeConfig.base_url,
      apiKey,
      apiKeyEnvVar,
      functionId: routeConfig.function_id,
      timeoutSeconds: routeConfig.timeout_seconds ?? modelConfig.timeout_seconds,
      cooldownSeconds:
        routeConfig.cooldown_seconds ?? modelConfig.default_cooldown_seconds,
      languageDefault: routeConfig.language_default,
      responseFormatDefault: routeConfig.response_format_default,
      capabilities: routeConfig.capabilities ?? {},
    };
  }

  private resolveApiKey(
    routeConfig: AudioRouteConfig,
    tracker: KeyCycleTracker,
  ): { apiKey: string; envVar: string } | undefined {
    if (routeConfig.api_key_env !== undefined && routeConfig.api_key_env.length > 0) {
      for (const envVar of routeConfig.api_key_env) {
        const value = process.env[envVar];
        if (value !== undefined && value.length > 0) return { apiKey: value, envVar };
      }
      return undefined;
    }
    try {
      const providerConfig = providerConfigLoader.loadProvider(routeConfig.provider);
      if (providerConfig.authentication.type === "none") {
        return { apiKey: "", envVar: "(none)" };
      }
    } catch {
      // fall through to key manager
    }
    const key = tracker.getNextKey();
    if (key === undefined) return undefined;
    return { apiKey: key, envVar: "(auto)" };
  }
}

function extractStatusCode(err: unknown): number | undefined {
  if (err instanceof AudioProviderCapabilityError) return err.statusCode;
  if (err instanceof AudioProviderUpstreamError) return err.statusCode;
  return undefined;
}

function resolveErrorAction(
  providerName: string,
  status: number | undefined,
): { action: ErrorAction; cooldownSeconds?: number } {
  if (status === undefined) return { action: "model_key_failure" };
  try {
    const config = providerConfigLoader.loadProvider(providerName);
    const entry = config.error_handling?.[String(status)];
    if (entry !== undefined) {
      const action = entry.action as ErrorAction;
      const out: { action: ErrorAction; cooldownSeconds?: number } = { action };
      const cooldown = (entry as { cooldown_seconds?: unknown }).cooldown_seconds;
      if (typeof cooldown === "number") out.cooldownSeconds = cooldown;
      return out;
    }
  } catch {
    // default below
  }
  if (status === 401 || status === 403) return { action: "global_key_failure" };
  if (status === 400 || status === 422) return { action: "pass_through" };
  if (status === 429) return { action: "provider_cooldown" };
  return { action: "model_key_failure" };
}

function keyHint(apiKey: string): string {
  if (apiKey.length === 0) return "(none)";
  return apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "****";
}

