import type {
  ModelRoutingConfig,
  ResolvedRoute,
  RouteConfig,
} from "../../shared/schemas/routing.ts";
import {
  Attempt,
  AttemptResult,
  RoutingError,
} from "../../shared/schemas/routing.ts";
import { modelConfigLoader } from "../config/model-loader.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { createLogger } from "../observability/logger.ts";
import { currentRequestId, emit, nowIso } from "../observability/request-context.ts";
import {
  KeyCycleTracker,
  getAvailableKeys,
  getKeyCooldownSeconds,
  getMaxKeyRetryCycles,
  type ErrorAction,
} from "../providers/api-key-manager.ts";
import {
  ProxyCycleTracker,
  providerHasEgressProxies,
  resolveRetryAfterSeconds,
} from "../providers/egress-proxy-manager.ts";
import { ProviderAPIError, RouteExecutionError } from "../providers/errors.ts";
import { getProviderWireProtocol } from "../providers/provider-helpers.ts";
import { recordRequestProgress } from "../server/request-log.ts";
import { execute, executeStream } from "./executor.ts";
import {
  fixMissingToolResponsesOpenAI,
  fixMissingToolResultsAnthropic,
} from "./tool-response-fixer.ts";

function keyHintOf(apiKey: string): string {
  if (usesPublicAuth(apiKey)) return "(public)";
  return apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "****";
}

function usesPublicAuth(apiKey: string): boolean {
  return apiKey === "public";
}

function proxyHintOf(proxyUrl: string): string {
  try {
    const parsed = new URL(proxyUrl);
    return parsed.host;
  } catch {
    return proxyUrl.replace(/\/\/[^@/]+@/, "//***@");
  }
}

function recordRouteProgress(route: ResolvedRoute, attemptNumber: number): void {
  const requestId = currentRequestId();
  if (requestId === undefined) return;
  recordRequestProgress({
    requestId,
    resolvedProvider: route.provider,
    resolvedModel: route.model,
    retryCount: Math.max(0, attemptNumber - 1),
  });
}

// Unused-declaration helpers to keep imports stable across callers.
void getAvailableKeys;
void getKeyCooldownSeconds;
void getMaxKeyRetryCycles;

const log = createLogger("routing.fallback");

const VERBOSE_HTTP_ERRORS =
  (process.env.VERBOSE_HTTP_ERRORS ?? "false").toLowerCase() === "true";

interface RouteTuple {
  routeConfig: RouteConfig;
  isFallback: boolean;
  sourceModel: string;
}

export interface CallWithFallbackArgs {
  logicalModel: string;
  requestData: Record<string, unknown>;
  targetProtocol: "openai" | "anthropic";
  maxKeyCycles?: number;
  signal?: AbortSignal;
  /** Extra headers forwarded to upstream providers (e.g. x-opencode-*). */
  extraHeaders?: Record<string, string>;
}

interface ErrorActionResult {
  action: ErrorAction;
  cooldownSeconds?: number;
}

function extractStatusCode(err: unknown): number | undefined {
  if (err instanceof ProviderAPIError) return err.status;
  if (err instanceof RouteExecutionError) return err.statusCode;
  if (err instanceof Error) {
    const maybeStatus = (err as unknown as { status?: unknown }).status;
    if (typeof maybeStatus === "number") return maybeStatus;
  }
  return undefined;
}

function isFallbackWorthy(err: unknown): boolean {
  const status = extractStatusCode(err);
  if (status !== undefined) {
    if (status >= 400 && status < 600) return true;
  }
  if (err instanceof Error) {
    if (err.name === "AbortError") return false;
    const msg = err.message.toLowerCase();
    return /timeout|connection|network|unreachable|reset|server error|internal server error|bad gateway|service unavailable|gateway timeout|too many requests|rate limit|temporarily|overloaded|capacity/.test(
      msg,
    );
  }
  return false;
}

function formatErrorForLog(
  err: unknown,
  provider: string,
  model: string,
  apiKey: string | undefined,
): string {
  const parts = [`provider=${provider}`, `model=${model}`];
  const status = extractStatusCode(err);
  if (status !== undefined) parts.push(`status=${status}`);
  if (status === 401 && apiKey !== undefined) {
    const hint = apiKey.length >= 4 ? `...${apiKey.slice(-4)}` : "***";
    parts.push(`key=${hint}`);
  }
  const base = parts.join(", ");
  if (VERBOSE_HTTP_ERRORS) {
    const msg = err instanceof Error ? err.message : String(err);
    return `${base}, error=${msg}`;
  }
  return base;
}

function resolveErrorAction(
  providerName: string,
  err: unknown,
): ErrorActionResult {
  const status = extractStatusCode(err);
  if (status === undefined) return { action: "model_key_failure" };

  if (status === 429 && err instanceof ProviderAPIError) {
    const retryAfter = resolveRetryAfterSeconds(err, providerName);
    if (
      err.body?.includes("FreeUsageLimitError") ||
      err.body?.includes("RateLimitError")
    ) {
      const out: ErrorActionResult = { action: "provider_cooldown" };
      if (retryAfter !== undefined) out.cooldownSeconds = retryAfter;
      return out;
    }
  }

  try {
    const cfg = providerConfigLoader.loadProvider(providerName);
    const handling = cfg.error_handling ?? {};
    const entry = handling[String(status)];
    if (entry !== undefined) {
      const rawAction = entry.action as string;
      // Python-era bundles may still carry "ignore" / "cooldown". Map them
      // to runtime-equivalent actions so fallback behavior stays correct
      // even if the file was never run through the bundle normalizer.
      const action: ErrorAction =
        rawAction === "ignore"
          ? "pass_through"
          : rawAction === "cooldown"
            ? "provider_cooldown"
            : (rawAction as ErrorAction);
      const cooldown = (entry as { cooldown_seconds?: unknown }).cooldown_seconds;
      const out: ErrorActionResult = { action };
      if (typeof cooldown === "number") out.cooldownSeconds = cooldown;
      return out;
    }
  } catch {
    // fall through to defaults
  }

  if (status === 401 || status === 403) return { action: "global_key_failure" };
  return { action: "model_key_failure" };
}

export class FallbackRouter {
  private visited = new Set<string>();
  private modelConfigCache = new Map<string, ModelRoutingConfig>();

  private getModelConfig(name: string): ModelRoutingConfig {
    const cached = this.modelConfigCache.get(name);
    if (cached !== undefined) return cached;
    const cfg = modelConfigLoader.loadConfig(name);
    this.modelConfigCache.set(name, cfg);
    return cfg;
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

    let config: ModelRoutingConfig;
    try {
      config = this.getModelConfig(logicalModel);
    } catch (err) {
      log.warn("failed to load config", {
        logicalModel,
        err: String(err),
      });
      this.visited.delete(logicalModel);
      return [];
    }

    const out: RouteTuple[] = [];
    for (const routeConfig of config.model_routings) {
      out.push({ routeConfig, isFallback, sourceModel: logicalModel });
    }
    for (const fallback of config.fallback_model_routings) {
      out.push(...this.collectRouteConfigsRecursive(fallback, true));
    }
    this.visited.delete(logicalModel);
    return out;
  }

  private createTrackerForRoute(
    routeConfig: RouteConfig,
    modelConfig: ModelRoutingConfig,
    maxKeyCycles: number | undefined,
  ): KeyCycleTracker {
    let providerCooldown: number | undefined;
    try {
      const providerCfg = providerConfigLoader.loadProvider(routeConfig.provider);
      providerCooldown = providerCfg.rate_limiting.cooldown_seconds;
    } catch {
      providerCooldown = undefined;
    }

    const routeCooldown =
      routeConfig.cooldown_seconds ?? modelConfig.default_cooldown_seconds;

    const options: ConstructorParameters<typeof KeyCycleTracker>[0] = {
      provider: routeConfig.provider,
      model: routeConfig.model,
    };
    if (maxKeyCycles !== undefined) options.maxCycles = maxKeyCycles;
    if (providerCooldown !== undefined) options.providerCooldownSeconds = providerCooldown;
    if (routeCooldown !== undefined) options.routeCooldownSeconds = routeCooldown;
    return new KeyCycleTracker(options);
  }

  private createProxyTrackerForRoute(
    routeConfig: RouteConfig,
    maxProxyCycles: number | undefined,
  ): ProxyCycleTracker | undefined {
    if (!providerHasEgressProxies(routeConfig.provider)) return undefined;

    let defaultCooldown: number | undefined;
    try {
      const providerCfg = providerConfigLoader.loadProvider(routeConfig.provider);
      defaultCooldown = providerCfg.egress_proxies?.cooldown_seconds;
    } catch {
      defaultCooldown = undefined;
    }

    const options: ConstructorParameters<typeof ProxyCycleTracker>[0] = {
      provider: routeConfig.provider,
      model: routeConfig.model,
    };
    if (maxProxyCycles !== undefined) options.maxCycles = maxProxyCycles;
    if (defaultCooldown !== undefined) options.defaultCooldownSeconds = defaultCooldown;
    if (routeConfig.egress_proxy_env !== undefined) {
      options.pinnedEnvVar = routeConfig.egress_proxy_env;
    }
    return new ProxyCycleTracker(options);
  }

  private buildResolvedRoute(
    routeConfig: RouteConfig,
    sourceLogicalModel: string,
    apiKey: string,
    apiKeyEnvVar: string,
    modelConfig: ModelRoutingConfig,
    options: {
      egressProxyUrl?: string;
      egressProxyEnvVar?: string;
      extraHeaders?: Record<string, string>;
    } = {},
  ): ResolvedRoute {
    const wireProtocol =
      routeConfig.wire_protocol ?? getProviderWireProtocol(routeConfig.provider);
    const route: ResolvedRoute = {
      sourceLogicalModel,
      wireProtocol,
      provider: routeConfig.provider,
      model: routeConfig.model,
      baseUrl: routeConfig.base_url,
      apiKey,
      apiKeyEnvVar,
      timeoutSeconds:
        routeConfig.timeout_seconds ?? modelConfig.timeout_seconds ?? 60,
      cooldownSeconds:
        routeConfig.cooldown_seconds ?? modelConfig.default_cooldown_seconds ?? 180,
    };
    if (options.egressProxyUrl !== undefined) route.egressProxyUrl = options.egressProxyUrl;
    if (options.egressProxyEnvVar !== undefined) {
      route.egressProxyEnvVar = options.egressProxyEnvVar;
    }
    if (options.extraHeaders !== undefined) route.extraHeaders = options.extraHeaders;
    return route;
  }

  private resolveApiKeyForRoute(
    routeConfig: RouteConfig,
    tracker: KeyCycleTracker,
  ): { apiKey: string; envVar: string } | undefined {
    if (routeConfig.auth_mode === "public") {
      return { apiKey: "public", envVar: "(public)" };
    }
    if (routeConfig.api_key_env !== undefined && routeConfig.api_key_env.length > 0) {
      for (const envVar of routeConfig.api_key_env) {
        const value = process.env[envVar];
        if (value !== undefined && value.length > 0) {
          return { apiKey: value, envVar };
        }
      }
      return undefined;
    }
    const key = tracker.getNextKey();
    if (key === undefined) return undefined;
    return { apiKey: key, envVar: "(auto)" };
  }

  private shouldSkipRoute(
    routeConfig: RouteConfig,
    tracker: KeyCycleTracker,
    proxyTracker: ProxyCycleTracker | undefined,
  ): boolean {
    if (
      routeConfig.api_key_env === undefined &&
      routeConfig.auth_mode !== "public" &&
      tracker.allKeysInCooldown()
    ) {
      log.info("skipping provider (all keys in cooldown)", {
        provider: routeConfig.provider,
        total: tracker.totalKeys,
      });
      return true;
    }
    if (proxyTracker !== undefined && proxyTracker.totalProxies > 0 && proxyTracker.allProxiesInCooldown()) {
      log.info("skipping provider (all egress proxies in cooldown)", {
        provider: routeConfig.provider,
        total: proxyTracker.totalProxies,
      });
      return true;
    }
    return false;
  }

  private handleAttemptError(
    err: unknown,
    route: ResolvedRoute,
    resolved: { apiKey: string; envVar: string },
    tracker: KeyCycleTracker,
    proxyTracker: ProxyCycleTracker | undefined,
    attemptNumber: number,
    _isFallback: boolean,
    errors: Array<Record<string, unknown>>,
  ): "continue_proxy" | "continue_key" | "break_route" | "throw" {
    const actionInfo = resolveErrorAction(route.provider, err);
    const action = actionInfo.action;
    const errorInfo = {
      attempt: attemptNumber,
      provider: route.provider,
      model: route.model,
      error: err instanceof Error ? err.message : String(err),
      error_type: err instanceof Error ? err.name : "Unknown",
    };
    const errStatus = extractStatusCode(err);
    const errMessage = err instanceof Error ? err.message : String(err);
    const errType = err instanceof Error ? err.name : "Unknown";

    if (action === "fallback_no_cooldown") {
      log.info("route failed (no cooldown)", {
        msg: formatErrorForLog(err, route.provider, route.model, resolved.apiKey),
      });
      emit({
        type: "route.failed",
        at: nowIso(),
        attempt: attemptNumber,
        provider: route.provider,
        model: route.model,
        ...(errStatus !== undefined ? { status: errStatus } : {}),
        errorType: errType,
        message: errMessage,
        willFallback: true,
      });
      errors.push(errorInfo);
      return "break_route";
    }

    if (
      errStatus === 429 &&
      route.egressProxyUrl !== undefined &&
      proxyTracker !== undefined
    ) {
      const cooldown = resolveRetryAfterSeconds(err, route.provider);
      proxyTracker.markFailed(route.egressProxyUrl, {
        ...(cooldown !== undefined ? { cooldownSeconds: cooldown } : {}),
      });
      emit({
        type: "proxy.cooldown",
        at: nowIso(),
        provider: route.provider,
        model: route.model,
        ...(route.egressProxyEnvVar !== undefined
          ? { egressProxyEnvVar: route.egressProxyEnvVar }
          : {}),
        egressProxyHint: proxyHintOf(route.egressProxyUrl),
        ...(cooldown !== undefined ? { cooldownSeconds: cooldown } : {}),
      });
      if (!proxyTracker.exhausted()) return "continue_proxy";
    }

    if (usesPublicAuth(resolved.apiKey) && errStatus === 429) {
      if (proxyTracker !== undefined && !proxyTracker.exhausted()) {
        return "continue_proxy";
      }
    } else {
      tracker.markFailed(resolved.apiKey, {
        action,
        ...(actionInfo.cooldownSeconds !== undefined
          ? { cooldownSeconds: actionInfo.cooldownSeconds }
          : {}),
      });
      emit({
        type: "key.cooldown",
        at: nowIso(),
        provider: route.provider,
        model: route.model,
        action,
        ...(actionInfo.cooldownSeconds !== undefined
          ? { cooldownSeconds: actionInfo.cooldownSeconds }
          : {}),
      });
    }

    if (isFallbackWorthy(err)) {
      log.warn("route failed (will fallback)", {
        msg: formatErrorForLog(err, route.provider, route.model, resolved.apiKey),
      });
      emit({
        type: "route.failed",
        at: nowIso(),
        attempt: attemptNumber,
        provider: route.provider,
        model: route.model,
        ...(errStatus !== undefined ? { status: errStatus } : {}),
        errorType: errType,
        message: errMessage,
        willFallback: true,
      });
      errors.push(errorInfo);
      if (
        proxyTracker !== undefined &&
        proxyTracker.totalProxies > 0 &&
        !proxyTracker.exhausted()
      ) {
        return "continue_proxy";
      }
      return "continue_key";
    }

    log.error("route failed (non-recoverable)", {
      msg: formatErrorForLog(err, route.provider, route.model, resolved.apiKey),
    });
    emit({
      type: "route.failed",
      at: nowIso(),
      attempt: attemptNumber,
      provider: route.provider,
      model: route.model,
      ...(errStatus !== undefined ? { status: errStatus } : {}),
      errorType: errType,
      message: errMessage,
      willFallback: false,
    });
    return "throw";
  }

  async callWithFallback(args: CallWithFallbackArgs): Promise<Record<string, unknown>> {
    const { logicalModel, requestData, targetProtocol, maxKeyCycles, signal, extraHeaders } =
      args;
    const routeTuples = this.collectRouteConfigs(logicalModel);
    if (routeTuples.length === 0) {
      throw new RoutingError(
        logicalModel,
        [],
        [{ error: "No routes available", error_type: "NoRoutesError" }],
        `No routes available for logical model '${logicalModel}'`,
      );
    }

    const allAttempts: Attempt[] = [];
    const errors: Array<Record<string, unknown>> = [];
    let attemptNumber = 1;

    outer: for (const { routeConfig, isFallback, sourceModel } of routeTuples) {
      const modelConfig = this.getModelConfig(sourceModel);
      const tracker = this.createTrackerForRoute(
        routeConfig,
        modelConfig,
        maxKeyCycles,
      );
      const proxyTracker = this.createProxyTrackerForRoute(routeConfig, undefined);

      if (this.shouldSkipRoute(routeConfig, tracker, proxyTracker)) {
        continue;
      }

      while (!tracker.exhausted()) {
        const resolved = this.resolveApiKeyForRoute(routeConfig, tracker);
        if (resolved === undefined) break;

        let directAttemptDone = false;
        proxyLoop: while (true) {
          let proxyEntry:
            | { url: string; envVar: string }
            | undefined;
          if (proxyTracker !== undefined && proxyTracker.totalProxies > 0) {
            proxyEntry = proxyTracker.getNextProxy();
            if (proxyEntry === undefined) break;
          } else {
            if (directAttemptDone) break;
            directAttemptDone = true;
          }

          const route = this.buildResolvedRoute(
            routeConfig,
            sourceModel,
            resolved.apiKey,
            resolved.envVar,
            modelConfig,
            {
              ...(proxyEntry !== undefined
                ? {
                    egressProxyUrl: proxyEntry.url,
                    egressProxyEnvVar: proxyEntry.envVar,
                  }
                : {}),
              ...(extraHeaders !== undefined ? { extraHeaders } : {}),
            },
          );

          const attempt: Attempt = {
            route,
            attemptNumber,
            isFallbackRoute: isFallback,
          };
          allAttempts.push(attempt);

          log.info("attempting route", {
            attempt: attemptNumber,
            provider: route.provider,
            model: route.model,
            isFallback,
            ...(proxyEntry !== undefined ? { egressProxy: proxyEntry.envVar } : {}),
          });
          emit({
            type: "route.attempted",
            at: nowIso(),
            attempt: attemptNumber,
            provider: route.provider,
            model: route.model,
            wireProtocol: route.wireProtocol,
            isFallback,
            keyHint: keyHintOf(resolved.apiKey),
            apiKeyEnvVar: resolved.envVar,
            ...(proxyEntry !== undefined
              ? {
                  egressProxyEnvVar: proxyEntry.envVar,
                  egressProxyHint: proxyHintOf(proxyEntry.url),
                }
              : {}),
          });
          recordRouteProgress(route, attemptNumber);

          const routeStartMs = performance.now();
          try {
            const result = await execute({
              route,
              requestData,
              targetProtocol,
              ...(signal !== undefined ? { signal } : {}),
            });
            log.info("route succeeded", {
              provider: route.provider,
              model: route.model,
            });
            emit({
              type: "route.succeeded",
              at: nowIso(),
              attempt: attemptNumber,
              provider: route.provider,
              model: route.model,
              latencyMs: Math.round(performance.now() - routeStartMs),
            });
            return result;
          } catch (err) {
            const actionInfo = resolveErrorAction(route.provider, err);
            if (actionInfo.action === "auto_fix_tool_responses") {
              log.info("attempting auto-fix for missing tool responses", {
                provider: route.provider,
                model: route.model,
              });
              emit({
                type: "autofix.applied",
                at: nowIso(),
                protocol: targetProtocol,
                provider: route.provider,
                model: route.model,
              });
              const fixed =
                targetProtocol === "anthropic"
                  ? fixMissingToolResultsAnthropic(requestData)
                  : fixMissingToolResponsesOpenAI(requestData);
              const fixStartMs = performance.now();
              try {
                const result = await execute({
                  route,
                  requestData: fixed,
                  targetProtocol,
                  ...(signal !== undefined ? { signal } : {}),
                });
                emit({
                  type: "route.succeeded",
                  at: nowIso(),
                  attempt: attemptNumber,
                  provider: route.provider,
                  model: route.model,
                  latencyMs: Math.round(performance.now() - fixStartMs),
                });
                return result;
              } catch (retryErr) {
                const disposition = this.handleAttemptError(
                  retryErr,
                  route,
                  resolved,
                  tracker,
                  proxyTracker,
                  attemptNumber,
                  isFallback,
                  errors,
                );
                attemptNumber += 1;
                if (disposition === "continue_proxy") continue proxyLoop;
                if (disposition === "continue_key") break proxyLoop;
                if (disposition === "break_route") break outer;
                throw retryErr;
              }
            }

            const disposition = this.handleAttemptError(
              err,
              route,
              resolved,
              tracker,
              proxyTracker,
              attemptNumber,
              isFallback,
              errors,
            );
            attemptNumber += 1;
            if (disposition === "continue_proxy") continue proxyLoop;
            if (disposition === "continue_key") break proxyLoop;
            if (disposition === "break_route") break outer;
            throw err;
          }
        }

        // Public auth uses a single synthetic key; once the proxy pool is exhausted, advance route.
        if (routeConfig.auth_mode === "public") {
          break;
        }

        if (routeConfig.api_key_env !== undefined) break outer;
      }
    }

    const message = this.formatRoutingErrorMessage(
      logicalModel,
      allAttempts,
      errors,
    );
    log.error("all routes failed", { logicalModel, attempts: allAttempts.length });
    throw new RoutingError(logicalModel, allAttempts, errors, message);
  }

  async *streamWithFallback(
    args: CallWithFallbackArgs,
  ): AsyncGenerator<string, void, unknown> {
    const { logicalModel, requestData, targetProtocol, maxKeyCycles, signal, extraHeaders } =
      args;
    const routeTuples = this.collectRouteConfigs(logicalModel);
    if (routeTuples.length === 0) {
      throw new RoutingError(
        logicalModel,
        [],
        [{ error: "No routes available", error_type: "NoRoutesError" }],
        `No routes available for logical model '${logicalModel}'`,
      );
    }

    const allAttempts: Attempt[] = [];
    const errors: Array<Record<string, unknown>> = [];
    let attemptNumber = 1;

    outer: for (const { routeConfig, isFallback, sourceModel } of routeTuples) {
      const modelConfig = this.getModelConfig(sourceModel);
      const tracker = this.createTrackerForRoute(
        routeConfig,
        modelConfig,
        maxKeyCycles,
      );
      const proxyTracker = this.createProxyTrackerForRoute(routeConfig, undefined);

      if (this.shouldSkipRoute(routeConfig, tracker, proxyTracker)) {
        continue;
      }

      while (!tracker.exhausted()) {
        const resolved = this.resolveApiKeyForRoute(routeConfig, tracker);
        if (resolved === undefined) break;

        let directAttemptDone = false;
        proxyLoop: while (true) {
          let proxyEntry:
            | { url: string; envVar: string }
            | undefined;
          if (proxyTracker !== undefined && proxyTracker.totalProxies > 0) {
            proxyEntry = proxyTracker.getNextProxy();
            if (proxyEntry === undefined) break;
          } else {
            if (directAttemptDone) break;
            directAttemptDone = true;
          }

          const route = this.buildResolvedRoute(
            routeConfig,
            sourceModel,
            resolved.apiKey,
            resolved.envVar,
            modelConfig,
            {
              ...(proxyEntry !== undefined
                ? {
                    egressProxyUrl: proxyEntry.url,
                    egressProxyEnvVar: proxyEntry.envVar,
                  }
                : {}),
              ...(extraHeaders !== undefined ? { extraHeaders } : {}),
            },
          );

          const attempt: Attempt = {
            route,
            attemptNumber,
            isFallbackRoute: isFallback,
          };
          allAttempts.push(attempt);

          log.info("attempting streaming route", {
            attempt: attemptNumber,
            provider: route.provider,
            model: route.model,
            isFallback,
            ...(proxyEntry !== undefined ? { egressProxy: proxyEntry.envVar } : {}),
          });
          emit({
            type: "route.attempted",
            at: nowIso(),
            attempt: attemptNumber,
            provider: route.provider,
            model: route.model,
            wireProtocol: route.wireProtocol,
            isFallback,
            keyHint: keyHintOf(resolved.apiKey),
            apiKeyEnvVar: resolved.envVar,
            ...(proxyEntry !== undefined
              ? {
                  egressProxyEnvVar: proxyEntry.envVar,
                  egressProxyHint: proxyHintOf(proxyEntry.url),
                }
              : {}),
          });
          recordRouteProgress(route, attemptNumber);

          const streamStartMs = performance.now();
          try {
            for await (const chunk of executeStream({
              route,
              requestData,
              targetProtocol,
              ...(signal !== undefined ? { signal } : {}),
            })) {
              yield chunk;
            }
            emit({
              type: "route.succeeded",
              at: nowIso(),
              attempt: attemptNumber,
              provider: route.provider,
              model: route.model,
              latencyMs: Math.round(performance.now() - streamStartMs),
            });
            return;
          } catch (err) {
            const actionInfo = resolveErrorAction(route.provider, err);
            if (actionInfo.action === "auto_fix_tool_responses") {
              const fixed =
                targetProtocol === "anthropic"
                  ? fixMissingToolResultsAnthropic(requestData)
                  : fixMissingToolResponsesOpenAI(requestData);
              try {
                for await (const chunk of executeStream({
                  route,
                  requestData: fixed,
                  targetProtocol,
                  ...(signal !== undefined ? { signal } : {}),
                })) {
                  yield chunk;
                }
                emit({
                  type: "route.succeeded",
                  at: nowIso(),
                  attempt: attemptNumber,
                  provider: route.provider,
                  model: route.model,
                  latencyMs: Math.round(performance.now() - streamStartMs),
                });
                return;
              } catch (retryErr) {
                const disposition = this.handleAttemptError(
                  retryErr,
                  route,
                  resolved,
                  tracker,
                  proxyTracker,
                  attemptNumber,
                  isFallback,
                  errors,
                );
                attemptNumber += 1;
                if (disposition === "continue_proxy") continue proxyLoop;
                if (disposition === "continue_key") break proxyLoop;
                if (disposition === "break_route") break outer;
                throw retryErr;
              }
            }

            const disposition = this.handleAttemptError(
              err,
              route,
              resolved,
              tracker,
              proxyTracker,
              attemptNumber,
              isFallback,
              errors,
            );
            attemptNumber += 1;
            if (disposition === "continue_proxy") continue proxyLoop;
            if (disposition === "continue_key") break proxyLoop;
            if (disposition === "break_route") break outer;
            throw err;
          }
        }

        if (routeConfig.auth_mode === "public") {
          break;
        }

        if (routeConfig.api_key_env !== undefined) break outer;
      }
    }

    throw new RoutingError(
      logicalModel,
      allAttempts,
      errors,
      this.formatRoutingErrorMessage(logicalModel, allAttempts, errors),
    );
  }

  private formatRoutingErrorMessage(
    logicalModel: string,
    attempts: Attempt[],
    errors: Array<Record<string, unknown>>,
  ): string {
    const parts: string[] = [`All routes failed for logical model '${logicalModel}'`];
    if (attempts.length === 0) {
      parts.push("No routes were available to try.");
      return parts.join("\n");
    }
    parts.push(`Attempted ${attempts.length} route(s):`);
    const byAttempt = new Map<number, Record<string, unknown>>();
    for (const err of errors) {
      const n = err["attempt"];
      if (typeof n === "number") byAttempt.set(n, err);
    }
    for (const attempt of attempts) {
      const err = byAttempt.get(attempt.attemptNumber) ?? {};
      const msg = typeof err["error"] === "string" ? err["error"] : "Unknown error";
      const type = typeof err["error_type"] === "string" ? err["error_type"] : "Unknown";
      const truncated = msg.length > 80 ? `${msg.slice(0, 80)}...` : msg;
      const marker = attempt.isFallbackRoute ? " [FALLBACK]" : "";
      parts.push(
        `  ${attempt.attemptNumber}. ${attempt.route.provider}/${attempt.route.model} (${attempt.route.wireProtocol})${marker} - FAILED (${type}: ${truncated})`,
      );
    }
    return parts.join("\n");
  }
}

// Silence unused-name diagnostic for a type that's exported for downstream use.
export type { AttemptResult };
