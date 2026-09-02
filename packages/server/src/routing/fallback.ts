import { sleep } from "../shared/utils.ts";
import type {
  HedgedRoutingConfig,
  ModelRoutingConfig,
  ResolvedRoute,
  RouteConfig,
} from "@model-proxy/contracts/schemas/index.ts";
import {
  Attempt,
  RoutingError,
} from "@model-proxy/contracts/schemas/routing.ts";
import { modelConfigLoader } from "../config/model-loader.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { createLogger } from "../observability/logger.ts";
import { currentRequestId, emit, nowIso } from "../observability/request-context.ts";
import { canUseLogicalModel, canUseRouteConfig } from "../policy/access-control.ts";
import {
  KeyCycleTracker,
} from "../providers/api-key-manager.ts";
import {
  ProxyCycleTracker,
  providerHasEgressProxies,
  resolveRetryAfterSeconds,
} from "../providers/egress-proxy-manager.ts";
import { ProviderAPIError } from "../providers/errors.ts";
import { getProviderWireProtocol } from "../providers/provider-helpers.ts";
import { recordRequestProgress } from "../server/request-log.ts";
import type { Principal } from "../storage/identity-store.ts";
import { getProviderConfigContextWindow } from "./context-window.ts";
import { describeRequestImages, resolveVisionModel } from "./image-describer.ts";
import { execute, executeStream } from "./executor.ts";
import {
  analyzeRequestForRouting,
  type RoutingRequestAnalysis,
} from "./request-analysis.ts";
import {
  fixMissingToolResponsesOpenAI,
  fixMissingToolResultsAnthropic,
} from "./tool-response-fixer.ts";
import {
  extractStatusCode,
  formatErrorForLog,
  isAbortLikeError,
  isFallbackWorthy,
  resolveErrorAction,
  shouldCooldownProxyForError,
} from "./error-classification.ts";
import {
  isMeaningfulStreamChunk,
  requireMeaningfulStream,
  shouldIgnoreReasoningForStreamWinner,
} from "./stream-inspection.ts";

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
    apiKeyEnvVar: route.apiKeyEnvVar,
    keyHint: keyHintOf(route.apiKey),
    retryCount: Math.max(0, attemptNumber - 1),
  });
}

const log = createLogger("routing.fallback");

interface RouteTuple {
  routeConfig: RouteConfig;
  isFallback: boolean;
  sourceModel: string;
}

interface HedgedRouteTuple extends RouteTuple {
  routeIndex: number;
}

type RouteSkipReason = "multimodal_unsupported" | "context_window_exceeded";

interface RouteSkip extends RouteTuple {
  reason: RouteSkipReason;
  estimatedPromptTokens?: number;
  contextWindow?: number;
}

interface HedgedResolvedCandidate {
  route: ResolvedRoute;
  routeConfig: RouteConfig;
  resolved: { apiKey: string; envVar: string };
  tracker: KeyCycleTracker;
  proxyTracker: ProxyCycleTracker | undefined;
  attempt: Attempt;
  routeIndex: number;
  weight: number;
}

interface HedgedCandidateCollection {
  candidates: HedgedResolvedCandidate[];
  skipped: RouteSkip[];
}

type HedgedOutcome =
  | {
      type: "success";
      candidate: HedgedResolvedCandidate;
      result: Record<string, unknown>;
      latencyMs: number;
    }
  | {
      type: "failed";
      candidate: HedgedResolvedCandidate;
      error: unknown;
    }
  | {
      type: "cancelled";
      candidate: HedgedResolvedCandidate;
    };

interface HedgedStreamState {
  candidate: HedgedResolvedCandidate;
  controller: AbortController;
  buffer: string[];
  emittedCount: number;
  bufferedBytes: number;
  dropped: boolean;
}

/** Cap on pre-meaningful chunks buffered per hedged candidate. */
const HEDGE_BUFFER_MAX_BYTES = 1024 * 1024;

type HedgedStreamEvent =
  | { type: "ready"; state: HedgedStreamState; latencyMs: number }
  | { type: "chunk"; state: HedgedStreamState; chunk: string }
  | { type: "done"; state: HedgedStreamState }
  | { type: "failed"; state: HedgedStreamState; error: unknown }
  | { type: "cancelled"; state: HedgedStreamState };

interface FallbackRouterOptions {
  random?: () => number;
  principal?: Principal;
}


function emitHedgeCancelled(
  candidate: HedgedResolvedCandidate,
  reason: "winner_selected" | "client_abort" | "not_started",
): void {
  emit({
    type: "route.hedge.candidate_cancelled",
    at: nowIso(),
    attempt: candidate.attempt.attemptNumber,
    provider: candidate.route.provider,
    model: candidate.route.model,
    reason,
  });
}

function emitHedgeFailed(
  candidate: HedgedResolvedCandidate,
  error: unknown,
): void {
  emit({
    type: "route.hedge.candidate_failed",
    at: nowIso(),
    attempt: candidate.attempt.attemptNumber,
    provider: candidate.route.provider,
    model: candidate.route.model,
    errorType: error instanceof Error ? error.name : "Unknown",
    message: error instanceof Error ? error.message : String(error),
  });
}

class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter(value);
      return;
    }
    this.values.push(value);
  }

  next(): Promise<T> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export interface CallWithFallbackArgs {
  logicalModel: string;
  requestData: Record<string, unknown>;
  targetProtocol: "openai" | "anthropic" | "responses";
  maxKeyCycles?: number;
  signal?: AbortSignal;
  principal?: Principal;
  validateResponse?: boolean;
  /** Extra headers forwarded to upstream providers (e.g. x-opencode-*). */
  extraHeaders?: Record<string, string>;
  /** Internal: skip the image-description fallback (vision description calls). */
  skipImageDescription?: boolean;
}

export class FallbackRouter {
  private visited = new Set<string>();
  private modelConfigCache = new Map<string, ModelRoutingConfig>();
  private readonly random: () => number;
  private readonly principal: Principal | undefined;

  constructor(options: FallbackRouterOptions = {}) {
    this.random = options.random ?? Math.random;
    this.principal = options.principal;
  }

  private getModelConfig(name: string): ModelRoutingConfig {
    const cached = this.modelConfigCache.get(name);
    if (cached !== undefined) return cached;
    const cfg = modelConfigLoader.loadConfig(name);
    this.modelConfigCache.set(name, cfg);
    return cfg;
  }

  collectRouteConfigs(logicalModel: string, principal = this.principal): RouteTuple[] {
    this.visited.clear();
    return this.collectRouteConfigsRecursive(logicalModel, false, principal);
  }

  private collectRouteConfigsRecursive(
    logicalModel: string,
    isFallback: boolean,
    principal: Principal | undefined,
  ): RouteTuple[] {
    if (!canUseLogicalModel(principal, logicalModel)) return [];
    if (this.visited.has(logicalModel)) return [];
    this.visited.add(logicalModel);

    let config: ModelRoutingConfig;
    try {
      config = this.getModelConfig(logicalModel);
    } catch (err) {
      const logPayload = {
        logicalModel,
        err: String(err),
      };
      if (isFallback) {
        log.debug("skipping missing fallback config", logPayload);
      } else {
        log.warn("failed to load config", logPayload);
      }
      this.visited.delete(logicalModel);
      return [];
    }

    const out: RouteTuple[] = [];
    for (const routeConfig of config.model_routings) {
      if (!canUseRouteConfig(principal, logicalModel, routeConfig)) continue;
      out.push({ routeConfig, isFallback, sourceModel: logicalModel });
    }
    for (const fallback of config.fallback_model_routings) {
      out.push(...this.collectRouteConfigsRecursive(fallback, true, principal));
    }
    this.visited.delete(logicalModel);
    return out;
  }

  private declaredContextWindow(
    routeConfig: RouteConfig,
    modelConfig: ModelRoutingConfig,
  ): number | undefined {
    return (
      routeConfig.context_window ??
      modelConfig.context_window ??
      getProviderConfigContextWindow(routeConfig.provider, routeConfig.model)
    );
  }

  private skipReasonForRoute(
    tuple: RouteTuple,
    analysis: RoutingRequestAnalysis,
  ): RouteSkip | undefined {
    const modelConfig = this.getModelConfig(tuple.sourceModel);
    const contextWindow = this.declaredContextWindow(tuple.routeConfig, modelConfig);
    if (
      analysis.hasMultimodalContent &&
      tuple.routeConfig.capabilities?.multimodal === false
    ) {
      return {
        ...tuple,
        reason: "multimodal_unsupported",
        ...(analysis.estimatedPromptTokens !== undefined
          ? { estimatedPromptTokens: analysis.estimatedPromptTokens }
          : {}),
        ...(contextWindow !== undefined ? { contextWindow } : {}),
      };
    }
    if (
      analysis.estimatedPromptTokens !== undefined &&
      contextWindow !== undefined &&
      analysis.estimatedPromptTokens > contextWindow
    ) {
      return {
        ...tuple,
        reason: "context_window_exceeded",
        estimatedPromptTokens: analysis.estimatedPromptTokens,
        contextWindow,
      };
    }
    return undefined;
  }

  private emitRouteSkipped(skip: RouteSkip): void {
    const { routeConfig } = skip;
    log.info("skipping incompatible route", {
      provider: routeConfig.provider,
      model: routeConfig.model,
      reason: skip.reason,
      sourceLogicalModel: skip.sourceModel,
      ...(skip.estimatedPromptTokens !== undefined
        ? { estimatedPromptTokens: skip.estimatedPromptTokens }
        : {}),
      ...(skip.contextWindow !== undefined ? { contextWindow: skip.contextWindow } : {}),
    });
    emit({
      type: "route.skipped",
      at: nowIso(),
      provider: routeConfig.provider,
      model: routeConfig.model,
      reason: skip.reason,
      sourceLogicalModel: skip.sourceModel,
      isFallback: skip.isFallback,
      ...(skip.estimatedPromptTokens !== undefined
        ? { estimatedPromptTokens: skip.estimatedPromptTokens }
        : {}),
      ...(skip.contextWindow !== undefined ? { contextWindow: skip.contextWindow } : {}),
    });
  }

  private eligibleRouteTuples<T extends RouteTuple>(
    routeTuples: T[],
    analysis: RoutingRequestAnalysis,
    options: { emitSkips: boolean } = { emitSkips: true },
  ): { eligible: T[]; skipped: RouteSkip[] } {
    const eligible: T[] = [];
    const skipped: RouteSkip[] = [];
    for (const tuple of routeTuples) {
      const skip = this.skipReasonForRoute(tuple, analysis);
      if (skip !== undefined) {
        skipped.push(skip);
        if (options.emitSkips) this.emitRouteSkipped(skip);
        continue;
      }
      eligible.push(tuple);
    }
    return { eligible, skipped };
  }

  private skippedRouteErrors(skipped: RouteSkip[]): Array<Record<string, unknown>> {
    return skipped.map((skip) => ({
      provider: skip.routeConfig.provider,
      model: skip.routeConfig.model,
      error: skip.reason,
      error_type: "RouteEligibilityError",
      ...(skip.estimatedPromptTokens !== undefined
        ? { estimated_prompt_tokens: skip.estimatedPromptTokens }
        : {}),
      ...(skip.contextWindow !== undefined ? { context_window: skip.contextWindow } : {}),
    }));
  }

  private createTrackerForRoute(
    routeConfig: RouteConfig,
    modelConfig: ModelRoutingConfig,
    maxKeyCycles: number | undefined,
    principal: Principal | undefined,
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
      principal,
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
    if (routeConfig.openai_body_defaults !== undefined) {
      route.openaiBodyDefaults = routeConfig.openai_body_defaults;
    }
    if (routeConfig.openai_body_extensions !== undefined) {
      route.openaiBodyExtensions = routeConfig.openai_body_extensions;
    }
    if (modelConfig.buffer_partial_tool_calls) {
      route.bufferPartialToolCalls = true;
    }
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

  private hedgedConfigFor(logicalModel: string): HedgedRoutingConfig | undefined {
    const config = this.getModelConfig(logicalModel).hedged_routing;
    return config?.enabled === true ? config : undefined;
  }

  private collectHedgedRouteTuples(
    logicalModel: string,
    config: HedgedRoutingConfig,
    principal: Principal | undefined,
  ): HedgedRouteTuple[] {
    const tuples = config.include_fallback_model_routings
      ? this.collectRouteConfigs(logicalModel, principal)
      : this.getModelConfig(logicalModel).model_routings.map((routeConfig) => ({
          routeConfig,
          isFallback: false,
          sourceModel: logicalModel,
        }));
    return tuples.map((tuple, routeIndex) => ({ ...tuple, routeIndex }));
  }

  private resolveHedgedConcurrency(config: HedgedRoutingConfig): number {
    const jitter =
      config.max_parallel_jitter > 0
        ? this.randomInt(0, config.max_parallel_jitter)
        : 0;
    const maxWithJitter = Math.min(30, config.max_parallel + jitter);
    const upper = Math.max(config.min_parallel, maxWithJitter);
    return this.randomInt(config.min_parallel, upper);
  }

  private collectHedgedCandidates({
    logicalModel,
    config,
    maxKeyCycles,
    extraHeaders,
    limit,
    principal,
    analysis,
  }: {
    logicalModel: string;
    config: HedgedRoutingConfig;
    maxKeyCycles: number | undefined;
    extraHeaders: Record<string, string> | undefined;
    limit: number;
    principal: Principal | undefined;
    analysis: RoutingRequestAnalysis;
  }): HedgedCandidateCollection {
    const collectedRouteTuples = this.collectHedgedRouteTuples(logicalModel, config, principal);
    const { eligible: routeTuples, skipped } = this.eligibleRouteTuples(
      collectedRouteTuples,
      analysis,
      { emitSkips: true },
    );
    const candidates: HedgedResolvedCandidate[] = [];
    let attemptNumber = 1;
    const collectionLimit = Math.max(limit * 4, limit + 4);
    const perRouteLimit = Math.max(
      1,
      Math.ceil(collectionLimit / Math.max(1, routeTuples.length)),
    );

    for (const { routeConfig, isFallback, sourceModel, routeIndex } of routeTuples) {
      const modelConfig = this.getModelConfig(sourceModel);
      const tracker = this.createTrackerForRoute(
        routeConfig,
        modelConfig,
        maxKeyCycles,
        principal,
      );
      const proxyProbe = this.createProxyTrackerForRoute(routeConfig, 1);
      if (this.shouldSkipRoute(routeConfig, tracker, proxyProbe)) continue;

      const keys = this.resolveHedgedKeys(routeConfig, tracker, perRouteLimit);
      if (keys.length === 0) continue;
      const proxyEntries = this.resolveHedgedProxyEntries(routeConfig, perRouteLimit);
      if (proxyEntries.length === 0) continue;

      let routeCandidateCount = 0;
      for (const resolved of keys) {
        for (const proxyEntry of proxyEntries) {
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
          candidates.push({
            route,
            routeConfig,
            resolved,
            tracker,
            proxyTracker:
              proxyEntry !== undefined
                ? this.createProxyTrackerForRoute(routeConfig, 1)
                : undefined,
            attempt: {
              route,
              attemptNumber,
              isFallbackRoute: isFallback,
            },
            routeIndex,
            weight: this.hedgedWeightForRoute(routeIndex, routeTuples.length, config),
          });
          attemptNumber += 1;
          routeCandidateCount += 1;
          if (routeCandidateCount >= perRouteLimit) break;
        }
        if (routeCandidateCount >= perRouteLimit) break;
      }
    }

    return {
      candidates: this.selectHedgedCandidates(candidates, limit),
      skipped,
    };
  }

  private resolveHedgedKeys(
    routeConfig: RouteConfig,
    tracker: KeyCycleTracker,
    limit: number,
  ): Array<{ apiKey: string; envVar: string }> {
    if (routeConfig.auth_mode === "public") {
      return [{ apiKey: "public", envVar: "(public)" }];
    }
    if (routeConfig.api_key_env !== undefined && routeConfig.api_key_env.length > 0) {
      const out: Array<{ apiKey: string; envVar: string }> = [];
      for (const envVar of routeConfig.api_key_env) {
        const value = process.env[envVar];
        if (value !== undefined && value.length > 0) {
          out.push({ apiKey: value, envVar });
        }
        if (out.length >= limit) break;
      }
      return out;
    }

    const out: Array<{ apiKey: string; envVar: string }> = [];
    while (!tracker.exhausted() && out.length < limit) {
      const key = tracker.getNextKey();
      if (key === undefined) break;
      out.push({ apiKey: key, envVar: "(auto)" });
    }
    return out;
  }

  private resolveHedgedProxyEntries(
    routeConfig: RouteConfig,
    limit: number,
  ): Array<{ url: string; envVar: string } | undefined> {
    const tracker = this.createProxyTrackerForRoute(routeConfig, 1);
    if (tracker === undefined || tracker.totalProxies === 0) return [undefined];
    if (tracker.allProxiesInCooldown()) return [];

    const out: Array<{ url: string; envVar: string }> = [];
    const max = Math.max(1, Math.min(limit, tracker.totalProxies));
    while (!tracker.exhausted() && out.length < max) {
      const entry = tracker.getNextProxy();
      if (entry === undefined) break;
      out.push(entry);
    }
    return out;
  }

  private hedgedWeightForRoute(
    routeIndex: number,
    routeCount: number,
    config: HedgedRoutingConfig,
  ): number {
    if (routeIndex === 0) return Math.max(0.01, config.primary_bias);
    const remaining = Math.max(0.01, 1 - config.primary_bias);
    return remaining / Math.max(1, routeCount - 1) / Math.max(1, routeIndex);
  }

  private selectHedgedCandidates(
    candidates: HedgedResolvedCandidate[],
    limit: number,
  ): HedgedResolvedCandidate[] {
    if (candidates.length <= limit) return candidates;
    const selected: HedgedResolvedCandidate[] = [];
    const firstPrimary = candidates.find((candidate) => candidate.routeIndex === 0);
    if (firstPrimary !== undefined) selected.push(firstPrimary);

    const seenRouteIndexes = new Set<number>();
    if (firstPrimary !== undefined) seenRouteIndexes.add(firstPrimary.routeIndex);
    for (const candidate of candidates) {
      if (selected.length >= limit) break;
      if (seenRouteIndexes.has(candidate.routeIndex)) continue;
      seenRouteIndexes.add(candidate.routeIndex);
      selected.push(candidate);
    }

    candidates
      .filter((candidate) => !selected.includes(candidate))
      .map((candidate) => ({
        candidate,
        score: -Math.log(Math.max(Number.MIN_VALUE, this.random())) / candidate.weight,
      }))
      .sort((a, b) => a.score - b.score)
      .slice(0, Math.max(0, limit - selected.length))
      .forEach((entry) => selected.push(entry.candidate));
    return selected;
  }

  private hedgedCandidatePoolLimit(
    logicalModel: string,
    config: HedgedRoutingConfig,
    maxParallel: number,
    principal: Principal | undefined,
    analysis: RoutingRequestAnalysis,
  ): number {
    const collectedRouteTuples = this.collectHedgedRouteTuples(logicalModel, config, principal);
    const routeCount = this.eligibleRouteTuples(collectedRouteTuples, analysis, {
      emitSkips: false,
    }).eligible.length;
    return Math.min(30, Math.max(maxParallel, routeCount));
  }

  private randomInt(min: number, max: number): number {
    const lower = Math.ceil(min);
    const upper = Math.floor(max);
    if (upper <= lower) return lower;
    return lower + Math.floor(this.random() * (upper - lower + 1));
  }

  private hedgedLaunchDelay(index: number, config: HedgedRoutingConfig): number {
    if (index === 0) return 0;
    const jitter =
      config.stagger_jitter_ms > 0
        ? this.randomInt(0, config.stagger_jitter_ms)
        : 0;
    return index * (config.stagger_ms + jitter);
  }

  private recordHedgeProgress(fields: {
    hedgedRouting?: boolean;
    hedgeCandidateCount?: number;
    hedgeCancelledCount?: number;
    hedgeFailedCount?: number;
  }): void {
    const requestId = currentRequestId();
    if (requestId === undefined) return;
    recordRequestProgress({ requestId, ...fields });
  }

  private emitHedgedAttempt(candidate: HedgedResolvedCandidate): void {
    emit({
      type: "route.attempted",
      at: nowIso(),
      attempt: candidate.attempt.attemptNumber,
      provider: candidate.route.provider,
      model: candidate.route.model,
      wireProtocol: candidate.route.wireProtocol,
      isFallback: candidate.attempt.isFallbackRoute,
      keyHint: keyHintOf(candidate.resolved.apiKey),
      apiKeyEnvVar: candidate.resolved.envVar,
      ...(candidate.route.egressProxyEnvVar !== undefined
        ? { egressProxyEnvVar: candidate.route.egressProxyEnvVar }
        : {}),
      ...(candidate.route.egressProxyUrl !== undefined
        ? { egressProxyHint: proxyHintOf(candidate.route.egressProxyUrl) }
        : {}),
    });
    emit({
      type: "route.hedge.candidate_started",
      at: nowIso(),
      attempt: candidate.attempt.attemptNumber,
      provider: candidate.route.provider,
      model: candidate.route.model,
      routeIndex: candidate.routeIndex,
    });
    recordRouteProgress(candidate.route, candidate.attempt.attemptNumber);
  }

  private async delayedHedgedCallCandidate({
    candidate,
    requestData,
    targetProtocol,
    signal,
    validateResponse,
    controller,
    state,
    delayMs,
  }: {
    candidate: HedgedResolvedCandidate;
    requestData: Record<string, unknown>;
    targetProtocol: "openai" | "anthropic" | "responses";
    signal: AbortSignal | undefined;
    validateResponse: boolean | undefined;
    controller: AbortController;
    state: { settled: boolean };
    delayMs: number;
  }): Promise<HedgedOutcome> {
    if (delayMs > 0) await sleep(delayMs);
    if (state.settled) {
      emitHedgeCancelled(candidate, "not_started");
      return { type: "cancelled", candidate };
    }

    const onClientAbort = () => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onClientAbort, { once: true });
    }

    const startedAt = performance.now();
    this.emitHedgedAttempt(candidate);
    log.info("attempting hedged route", {
      attempt: candidate.attempt.attemptNumber,
      provider: candidate.route.provider,
      model: candidate.route.model,
      routeIndex: candidate.routeIndex,
      ...(candidate.route.egressProxyEnvVar !== undefined
        ? { egressProxy: candidate.route.egressProxyEnvVar }
        : {}),
    });

    try {
      const result = await execute({
        route: candidate.route,
        requestData,
        targetProtocol,
        ...(validateResponse !== undefined ? { validateResponse } : {}),
        signal: controller.signal,
      });
      return {
        type: "success",
        candidate,
        result,
        latencyMs: Math.round(performance.now() - startedAt),
      };
    } catch (error) {
      if (state.settled && isAbortLikeError(error)) {
        return { type: "cancelled", candidate };
      }
      return { type: "failed", candidate, error };
    } finally {
      if (signal !== undefined) signal.removeEventListener("abort", onClientAbort);
    }
  }

  private async callWithHedgedRouting(
    args: CallWithFallbackArgs,
    config: HedgedRoutingConfig,
  ): Promise<Record<string, unknown>> {
    const { logicalModel, requestData, targetProtocol, maxKeyCycles, signal, validateResponse, extraHeaders, principal } =
      args;
    const maxParallel = this.resolveHedgedConcurrency(config);
    const resolvedPrincipal = principal ?? this.principal;
    const analysis = analyzeRequestForRouting(requestData);
    const collection = this.collectHedgedCandidates({
      logicalModel,
      config,
      maxKeyCycles,
      extraHeaders,
      limit: this.hedgedCandidatePoolLimit(
        logicalModel,
        config,
        maxParallel,
        resolvedPrincipal,
        analysis,
      ),
      principal: resolvedPrincipal,
      analysis,
    });
    const { candidates, skipped } = collection;

    if (candidates.length === 0) {
      const skippedErrors = this.skippedRouteErrors(skipped);
      throw new RoutingError(
        logicalModel,
        [],
        skippedErrors.length > 0
          ? skippedErrors
          : [{ error: "No hedged routes available", error_type: "NoRoutesError" }],
        skippedErrors.length > 0
          ? `No eligible hedged routes available for logical model '${logicalModel}'`
          : `No hedged routes available for logical model '${logicalModel}'`,
      );
    }

    emit({
      type: "route.hedge.started",
      at: nowIso(),
      candidates: candidates.length,
      maxParallel,
      stream: false,
    });
    this.recordHedgeProgress({
      hedgedRouting: true,
      hedgeCandidateCount: candidates.length,
      hedgeCancelledCount: 0,
      hedgeFailedCount: 0,
    });

    const state = { settled: false };
    const controllers = candidates.map(() => new AbortController());
    const errors: Array<Record<string, unknown>> = [];
    let failedCount = 0;
    let cancelledCount = 0;
    const pending = new Map<number, Promise<{ index: number; outcome: HedgedOutcome }>>();
    let nextCandidateIndex = 0;

    const launchNextCandidate = (delayMs: number): void => {
      if (state.settled || nextCandidateIndex >= candidates.length) return;
      const index = nextCandidateIndex;
      nextCandidateIndex += 1;
      const candidate = candidates[index]!;
      const promise = this.delayedHedgedCallCandidate({
        candidate,
        requestData,
        targetProtocol,
        signal,
        validateResponse,
        controller: controllers[index]!,
        state,
        delayMs,
      }).then((outcome) => ({ index, outcome }));
      pending.set(index, promise);
    };

    const initialCandidates = Math.min(maxParallel, candidates.length);
    for (let index = 0; index < initialCandidates; index += 1) {
      launchNextCandidate(this.hedgedLaunchDelay(index, config));
    }

    while (pending.size > 0) {
      const { index, outcome } = await Promise.race(pending.values());
      pending.delete(index);

      if (outcome.type === "cancelled") {
        cancelledCount += 1;
        this.recordHedgeProgress({ hedgeCancelledCount: cancelledCount });
        launchNextCandidate(0);
        continue;
      }

      if (outcome.type === "success") {
        state.settled = true;
        const cancelled = this.abortHedgedLosers(candidates, controllers, index);
        cancelledCount += cancelled;
        this.recordHedgeProgress({
          hedgeCancelledCount: cancelledCount,
          hedgeFailedCount: failedCount,
        });
        emit({
          type: "route.hedge.candidate_won",
          at: nowIso(),
          attempt: outcome.candidate.attempt.attemptNumber,
          provider: outcome.candidate.route.provider,
          model: outcome.candidate.route.model,
          latencyMs: outcome.latencyMs,
          cancelledCandidates: cancelledCount,
          failedCandidates: failedCount,
        });
        emit({
          type: "route.succeeded",
          at: nowIso(),
          attempt: outcome.candidate.attempt.attemptNumber,
          provider: outcome.candidate.route.provider,
          model: outcome.candidate.route.model,
          latencyMs: outcome.latencyMs,
        });
        return outcome.result;
      }

      failedCount += 1;
      this.recordHedgeProgress({ hedgeFailedCount: failedCount });
      emitHedgeFailed(outcome.candidate, outcome.error);
      const disposition = this.handleAttemptError(
        outcome.error,
        outcome.candidate.route,
        outcome.candidate.resolved,
        outcome.candidate.tracker,
        outcome.candidate.proxyTracker,
        outcome.candidate.attempt.attemptNumber,
        outcome.candidate.attempt.isFallbackRoute,
        errors,
      );
      if (signal?.aborted === true || disposition === "throw") {
        state.settled = true;
        this.abortHedgedLosers(candidates, controllers, index, "client_abort");
        throw outcome.error;
      }
      launchNextCandidate(0);
    }

    const attemptedCandidates = candidates.slice(0, nextCandidateIndex);

    throw new RoutingError(
      logicalModel,
      attemptedCandidates.map((candidate) => candidate.attempt),
      errors,
      this.formatRoutingErrorMessage(
        logicalModel,
        attemptedCandidates.map((candidate) => candidate.attempt),
        errors,
      ),
    );
  }

  private abortHedgedLosers(
    candidates: HedgedResolvedCandidate[],
    controllers: AbortController[],
    winnerIndex: number,
    reason: "winner_selected" | "client_abort" = "winner_selected",
  ): number {
    let cancelled = 0;
    candidates.forEach((candidate, index) => {
      if (index === winnerIndex) return;
      const controller = controllers[index];
      if (controller === undefined || controller.signal.aborted) return;
      controller.abort();
      cancelled += 1;
      emitHedgeCancelled(candidate, reason);
    });
    return cancelled;
  }

  private async runHedgedStreamCandidate({
    streamState,
    requestData,
    targetProtocol,
    signal,
    shared,
    queue,
    delayMs,
    minContentChars,
    ignoreReasoningForWinner,
  }: {
    streamState: HedgedStreamState;
    requestData: Record<string, unknown>;
    targetProtocol: "openai" | "anthropic" | "responses";
    signal: AbortSignal | undefined;
    shared: { winner: HedgedStreamState | undefined; settled: boolean };
    queue: AsyncQueue<HedgedStreamEvent>;
    delayMs: number;
    minContentChars: number;
    ignoreReasoningForWinner: boolean;
  }): Promise<void> {
    if (delayMs > 0) await sleep(delayMs);
    if (shared.settled) {
      emitHedgeCancelled(streamState.candidate, "not_started");
      queue.push({ type: "cancelled", state: streamState });
      return;
    }

    const onClientAbort = () => streamState.controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) streamState.controller.abort();
      else signal.addEventListener("abort", onClientAbort, { once: true });
    }

    const startedAt = performance.now();
    this.emitHedgedAttempt(streamState.candidate);
    log.info("attempting hedged streaming route", {
      attempt: streamState.candidate.attempt.attemptNumber,
      provider: streamState.candidate.route.provider,
      model: streamState.candidate.route.model,
      routeIndex: streamState.candidate.routeIndex,
      ...(streamState.candidate.route.egressProxyEnvVar !== undefined
        ? { egressProxy: streamState.candidate.route.egressProxyEnvVar }
        : {}),
    });

    try {
      for await (const chunk of executeStream({
        route: streamState.candidate.route,
        requestData,
        targetProtocol,
        signal: streamState.controller.signal,
      })) {
        if (shared.winner === streamState) {
          queue.push({ type: "chunk", state: streamState, chunk });
          continue;
        }
        if (shared.winner !== undefined) {
          continue;
        }
        streamState.buffer.push(chunk);
        streamState.bufferedBytes += chunk.length;
        if (streamState.bufferedBytes > HEDGE_BUFFER_MAX_BYTES) {
          // Candidate buffered too much without meaningful content; it is not
          // viable as a winner and would otherwise grow memory unboundedly.
          // Push exactly one terminal event ("failed") and stop consuming;
          // the post-loop "done" push and the catch below both check
          // `dropped` so this state is never reported twice.
          streamState.dropped = true;
          streamState.controller.abort();
          queue.push({
            type: "failed",
            state: streamState,
            error: new ProviderAPIError(
              `${streamState.candidate.route.provider} stream buffered ${HEDGE_BUFFER_MAX_BYTES} bytes without meaningful content`,
              502,
              { provider: streamState.candidate.route.provider },
            ),
          });
          break;
        }
        if (
          isMeaningfulStreamChunk(chunk, targetProtocol, minContentChars, {
            ignoreReasoning: ignoreReasoningForWinner,
          })
        ) {
          queue.push({
            type: "ready",
            state: streamState,
            latencyMs: Math.round(performance.now() - startedAt),
          });
        }
      }
      if (!streamState.dropped) queue.push({ type: "done", state: streamState });
    } catch (error) {
      if (streamState.dropped) {
        // Terminal "failed" event already queued when the buffer cap tripped.
      } else if (shared.settled && isAbortLikeError(error)) {
        queue.push({ type: "cancelled", state: streamState });
      } else {
        queue.push({ type: "failed", state: streamState, error });
      }
    } finally {
      if (signal !== undefined) signal.removeEventListener("abort", onClientAbort);
    }
  }

  private async *streamWithHedgedRouting(
    args: CallWithFallbackArgs,
    config: HedgedRoutingConfig,
  ): AsyncGenerator<string, void, unknown> {
    const { logicalModel, requestData, targetProtocol, maxKeyCycles, signal, extraHeaders, principal } =
      args;
    const maxParallel = this.resolveHedgedConcurrency(config);
    const resolvedPrincipal = principal ?? this.principal;
    const analysis = analyzeRequestForRouting(requestData);
    const collection = this.collectHedgedCandidates({
      logicalModel,
      config,
      maxKeyCycles,
      extraHeaders,
      limit: this.hedgedCandidatePoolLimit(
        logicalModel,
        config,
        maxParallel,
        resolvedPrincipal,
        analysis,
      ),
      principal: resolvedPrincipal,
      analysis,
    });
    const { candidates, skipped } = collection;

    if (candidates.length === 0) {
      const skippedErrors = this.skippedRouteErrors(skipped);
      throw new RoutingError(
        logicalModel,
        [],
        skippedErrors.length > 0
          ? skippedErrors
          : [{ error: "No hedged routes available", error_type: "NoRoutesError" }],
        skippedErrors.length > 0
          ? `No eligible hedged routes available for logical model '${logicalModel}'`
          : `No hedged routes available for logical model '${logicalModel}'`,
      );
    }

    emit({
      type: "route.hedge.started",
      at: nowIso(),
      candidates: candidates.length,
      maxParallel,
      stream: true,
    });
    this.recordHedgeProgress({
      hedgedRouting: true,
      hedgeCandidateCount: candidates.length,
      hedgeCancelledCount: 0,
      hedgeFailedCount: 0,
    });

    const queue = new AsyncQueue<HedgedStreamEvent>();
    const shared: { winner: HedgedStreamState | undefined; settled: boolean } = {
      winner: undefined,
      settled: false,
    };
    const states: HedgedStreamState[] = candidates.map((candidate) => ({
      candidate,
      controller: new AbortController(),
      buffer: [],
      emittedCount: 0,
      bufferedBytes: 0,
      dropped: false,
    }));
    let finishedStates = 0;
    let failedCount = 0;
    let cancelledCount = 0;
    let yieldedToClient = false;
    // For tool-call requests a reasoning-only stream must not win the hedge
    // (the model may never emit tool calls); for plain requests, reasoning
    // deltas are meaningful output and should select the winner.
    const ignoreReasoningForWinner = shouldIgnoreReasoningForStreamWinner(requestData);
    const errors: Array<Record<string, unknown>> = [];
    let nextStateIndex = 0;

    const launchNextStream = (delayMs: number): void => {
      if (shared.settled || nextStateIndex >= states.length) return;
      const streamState = states[nextStateIndex]!;
      nextStateIndex += 1;
      void this.runHedgedStreamCandidate({
        streamState,
        requestData,
        targetProtocol,
        signal,
        shared,
        queue,
        delayMs,
        minContentChars: config.stream_min_content_chars,
        ignoreReasoningForWinner,
      });
    };

    const initialStreams = Math.min(maxParallel, states.length);
    for (let index = 0; index < initialStreams; index += 1) {
      launchNextStream(this.hedgedLaunchDelay(index, config));
    }

    while (finishedStates < states.length) {
      const event = await queue.next();
      if (event.type === "cancelled") {
        finishedStates += 1;
        cancelledCount += 1;
        this.recordHedgeProgress({ hedgeCancelledCount: cancelledCount });
        launchNextStream(0);
        continue;
      }

      if (event.type === "failed") {
        finishedStates += 1;
        failedCount += 1;
        this.recordHedgeProgress({ hedgeFailedCount: failedCount });
        emitHedgeFailed(event.state.candidate, event.error);
        if (shared.winner === event.state && yieldedToClient) {
          throw event.error;
        }
        const disposition = this.handleAttemptError(
          event.error,
          event.state.candidate.route,
          event.state.candidate.resolved,
          event.state.candidate.tracker,
          event.state.candidate.proxyTracker,
          event.state.candidate.attempt.attemptNumber,
          event.state.candidate.attempt.isFallbackRoute,
          errors,
        );
        if (signal?.aborted === true || disposition === "throw") {
          shared.settled = true;
          cancelledCount += this.abortHedgedStreamLosers(states, event.state, "client_abort");
          this.recordHedgeProgress({ hedgeCancelledCount: cancelledCount });
          throw event.error;
        }
        launchNextStream(0);
        continue;
      }

      if (event.type === "ready" && shared.winner === undefined) {
        shared.winner = event.state;
        shared.settled = true;
        cancelledCount += this.abortHedgedStreamLosers(states, event.state);
        this.recordHedgeProgress({
          hedgeCancelledCount: cancelledCount,
          hedgeFailedCount: failedCount,
        });
        emit({
          type: "route.hedge.candidate_won",
          at: nowIso(),
          attempt: event.state.candidate.attempt.attemptNumber,
          provider: event.state.candidate.route.provider,
          model: event.state.candidate.route.model,
          latencyMs: event.latencyMs,
          cancelledCandidates: cancelledCount,
          failedCandidates: failedCount,
        });
        emit({
          type: "route.succeeded",
          at: nowIso(),
          attempt: event.state.candidate.attempt.attemptNumber,
          provider: event.state.candidate.route.provider,
          model: event.state.candidate.route.model,
          latencyMs: event.latencyMs,
        });
        while (event.state.emittedCount < event.state.buffer.length) {
          const chunk = event.state.buffer[event.state.emittedCount]!;
          event.state.emittedCount += 1;
          yieldedToClient = true;
          yield chunk;
        }
        continue;
      }

      if (event.type === "chunk") {
        if (shared.winner !== event.state) continue;
        yieldedToClient = true;
        yield event.chunk;
        continue;
      }

      if (event.type === "done") {
        finishedStates += 1;
        if (shared.winner === event.state) return;
        if (shared.winner === undefined && event.state.buffer.length > 0) {
          // A stream that finished without a meaningful chunk is unusable for
          // winner selection; treat it like an empty response and keep racing.
          const error = new ProviderAPIError(
            `${event.state.candidate.route.provider} stream ended before emitting meaningful content`,
            502,
            { provider: event.state.candidate.route.provider },
          );
          failedCount += 1;
          this.recordHedgeProgress({ hedgeFailedCount: failedCount });
          emitHedgeFailed(event.state.candidate, error);
          const disposition = this.handleAttemptError(
            error,
            event.state.candidate.route,
            event.state.candidate.resolved,
            event.state.candidate.tracker,
            event.state.candidate.proxyTracker,
            event.state.candidate.attempt.attemptNumber,
            event.state.candidate.attempt.isFallbackRoute,
            errors,
          );
          if (signal?.aborted === true || disposition === "throw") {
            shared.settled = true;
            cancelledCount += this.abortHedgedStreamLosers(states, event.state, "client_abort");
            this.recordHedgeProgress({ hedgeCancelledCount: cancelledCount });
            throw error;
          }
        }
        if (shared.winner === undefined) launchNextStream(0);
      }
    }

    const attemptedStates = states.slice(0, nextStateIndex);

    throw new RoutingError(
      logicalModel,
      attemptedStates.map((state) => state.candidate.attempt),
      errors,
      this.formatRoutingErrorMessage(
        logicalModel,
        attemptedStates.map((state) => state.candidate.attempt),
        errors,
      ),
    );
  }

  private abortHedgedStreamLosers(
    states: HedgedStreamState[],
    winner: HedgedStreamState,
    reason: "winner_selected" | "client_abort" = "winner_selected",
  ): number {
    let cancelled = 0;
    for (const state of states) {
      if (state === winner || state.controller.signal.aborted) continue;
      state.controller.abort();
      cancelled += 1;
      emitHedgeCancelled(state.candidate, reason);
    }
    return cancelled;
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
  ): "continue_proxy" | "continue_key" | "continue_route" | "throw" {
    const actionInfo = resolveErrorAction(route.provider, err);
    const action = actionInfo.action;
    const errStatus = extractStatusCode(err);
    const errMessage = err instanceof Error ? err.message : String(err);
    const errType = err instanceof Error ? err.name : "Unknown";
    const errorInfo = {
      attempt: attemptNumber,
      provider: route.provider,
      model: route.model,
      error: errMessage,
      error_type: errType,
      ...(errStatus !== undefined ? { status_code: errStatus } : {}),
    };

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
      return "continue_route";
    }

    if (route.egressProxyUrl !== undefined && proxyTracker !== undefined && (
      errStatus === 429 || shouldCooldownProxyForError(err)
    )) {
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

  private ownRouteTuples(logicalModel: string, principal: Principal | undefined): RouteTuple[] {
    return this.collectRouteConfigs(logicalModel, principal).filter(
      (tuple) => tuple.sourceModel === logicalModel && tuple.isFallback !== true,
    );
  }
  private async withImageDescriptions(args: CallWithFallbackArgs): Promise<CallWithFallbackArgs> {
    if (args.skipImageDescription === true) return args;
    const principal = args.principal ?? this.principal;
    const analysis = analyzeRequestForRouting(args.requestData);
    if (!analysis.hasMultimodalContent) return args;
    const ownTuples = this.ownRouteTuples(args.logicalModel, principal);
    if (ownTuples.length === 0) return args;
    const { skipped } = this.eligibleRouteTuples(ownTuples, analysis, { emitSkips: false });
    if (!skipped.some((skip) => skip.reason === "multimodal_unsupported")) return args;
    const visionModel = resolveVisionModel(principal);
    if (visionModel === undefined) {
      log.info("no vision-capable model available to describe images", { logicalModel: args.logicalModel });
      return args;
    }
    try {
      const result = await describeRequestImages({
        requestData: args.requestData,
        visionModel,
        callModel: async (requestData) =>
          await this.callWithFallback({
            logicalModel: visionModel,
            requestData,
            targetProtocol: "openai",
            signal: args.signal,
            principal,
            validateResponse: false,
            skipImageDescription: true,
          }),
      });
      if (result === undefined) return args;
      log.info("routed image request through vision descriptions", {
        logicalModel: args.logicalModel,
        visionModel,
        imageCount: result.imageCount,
        cacheHits: result.cacheHits,
      });
      emit({
        type: "route.images_described",
        at: nowIso(),
        visionModel,
        imageCount: result.imageCount,
        cacheHits: result.cacheHits,
        sourceLogicalModel: args.logicalModel,
      });
      return { ...args, requestData: result.requestData, skipImageDescription: true };
    } catch (err) {
      log.warn("image description fallback failed", {
        logicalModel: args.logicalModel,
        visionModel,
        error: String(err),
      });
      return args;
    }
  }

  async callWithFallback(args: CallWithFallbackArgs): Promise<Record<string, unknown>> {
    args = await this.withImageDescriptions(args);
    const { logicalModel, requestData, targetProtocol, maxKeyCycles, signal, validateResponse, extraHeaders, principal } =
      args;
    const hedgedConfig = this.hedgedConfigFor(logicalModel);
    if (hedgedConfig !== undefined) {
      return this.callWithHedgedRouting(args, hedgedConfig);
    }
    const collectedRouteTuples = this.collectRouteConfigs(logicalModel, principal ?? this.principal);
    if (collectedRouteTuples.length === 0) {
      throw new RoutingError(
        logicalModel,
        [],
        [{ error: "No routes available", error_type: "NoRoutesError" }],
        `No routes available for logical model '${logicalModel}'`,
      );
    }
    const analysis = analyzeRequestForRouting(requestData);
    const { eligible: routeTuples, skipped } = this.eligibleRouteTuples(
      collectedRouteTuples,
      analysis,
    );
    if (routeTuples.length === 0) {
      throw new RoutingError(
        logicalModel,
        [],
        this.skippedRouteErrors(skipped),
        `No eligible routes available for logical model '${logicalModel}'`,
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
        principal ?? this.principal,
      );
      const routeProxyTracker = this.createProxyTrackerForRoute(routeConfig, undefined);

      if (this.shouldSkipRoute(routeConfig, tracker, routeProxyTracker)) {
        continue;
      }

      while (!tracker.exhausted()) {
        const resolved = this.resolveApiKeyForRoute(routeConfig, tracker);
        if (resolved === undefined) break;

        // Fresh tracker per key so every key retries the full proxy pool.
        // Proxy cooldown state is shared globally, so proxies cooled down by
        // a previous key stay skipped.
        const proxyTracker =
          routeProxyTracker !== undefined
            ? this.createProxyTrackerForRoute(routeConfig, undefined)
            : undefined;

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
              ...(validateResponse !== undefined ? { validateResponse } : {}),
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
            if (signal?.aborted === true) throw err;
            const actionInfo = resolveErrorAction(route.provider, err);
            if (actionInfo.action === "auto_fix_tool_responses") {
              if (targetProtocol === "responses") throw err;
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
                  ...(validateResponse !== undefined ? { validateResponse } : {}),
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
                if (signal?.aborted) throw retryErr;
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
                if (disposition === "continue_route") continue outer;
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
            if (disposition === "continue_route") continue outer;
            throw err;
          }
        }

        // Public auth uses a single synthetic key; once the proxy pool is exhausted, advance route.
        if (routeConfig.auth_mode === "public") {
          break;
        }

        if (routeConfig.api_key_env !== undefined) break;
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
    args = await this.withImageDescriptions(args);
    const { logicalModel, requestData, targetProtocol, maxKeyCycles, signal, extraHeaders, principal } =
      args;
    const hedgedConfig = this.hedgedConfigFor(logicalModel);
    if (hedgedConfig !== undefined) {
      yield* this.streamWithHedgedRouting(args, hedgedConfig);
      return;
    }
    const collectedRouteTuples = this.collectRouteConfigs(logicalModel, principal ?? this.principal);
    if (collectedRouteTuples.length === 0) {
      throw new RoutingError(
        logicalModel,
        [],
        [{ error: "No routes available", error_type: "NoRoutesError" }],
        `No routes available for logical model '${logicalModel}'`,
      );
    }
    const analysis = analyzeRequestForRouting(requestData);
    const { eligible: routeTuples, skipped } = this.eligibleRouteTuples(
      collectedRouteTuples,
      analysis,
    );
    if (routeTuples.length === 0) {
      throw new RoutingError(
        logicalModel,
        [],
        this.skippedRouteErrors(skipped),
        `No eligible routes available for logical model '${logicalModel}'`,
      );
    }

    const allAttempts: Attempt[] = [];
    const errors: Array<Record<string, unknown>> = [];
    let attemptNumber = 1;
    const allowEmptyPassthrough = routeTuples.length === 1;

    outer: for (const { routeConfig, isFallback, sourceModel } of routeTuples) {
      const modelConfig = this.getModelConfig(sourceModel);
      const tracker = this.createTrackerForRoute(
        routeConfig,
        modelConfig,
        maxKeyCycles,
        principal ?? this.principal,
      );
      const routeProxyTracker = this.createProxyTrackerForRoute(routeConfig, undefined);

      if (this.shouldSkipRoute(routeConfig, tracker, routeProxyTracker)) {
        continue;
      }

      while (!tracker.exhausted()) {
        const resolved = this.resolveApiKeyForRoute(routeConfig, tracker);
        if (resolved === undefined) break;

        // Fresh tracker per key so every key retries the full proxy pool.
        // Proxy cooldown state is shared globally, so proxies cooled down by
        // a previous key stay skipped.
        const proxyTracker =
          routeProxyTracker !== undefined
            ? this.createProxyTrackerForRoute(routeConfig, undefined)
            : undefined;

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
            const stream = executeStream({
              route,
              requestData,
              targetProtocol,
              ...(signal !== undefined ? { signal } : {}),
            });
            for await (const chunk of requireMeaningfulStream(
              stream,
              route,
              requestData,
              targetProtocol,
              { allowEmptyPassthrough },
            )) {
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
            if (signal?.aborted === true) throw err;
            const actionInfo = resolveErrorAction(route.provider, err);
            if (actionInfo.action === "auto_fix_tool_responses") {
              if (targetProtocol === "responses") throw err;
              const fixed =
                targetProtocol === "anthropic"
                  ? fixMissingToolResultsAnthropic(requestData)
                  : fixMissingToolResponsesOpenAI(requestData);
              try {
                const retryStream = executeStream({
                  route,
                  requestData: fixed,
                  targetProtocol,
                  ...(signal !== undefined ? { signal } : {}),
                });
                for await (const chunk of requireMeaningfulStream(
                  retryStream,
                  route,
                  fixed,
                  targetProtocol,
                  { allowEmptyPassthrough },
                )) {
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
                if (signal?.aborted) throw retryErr;
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
                if (disposition === "continue_route") continue outer;
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
            if (disposition === "continue_route") continue outer;
            throw err;
          }
        }

        if (routeConfig.auth_mode === "public") {
          break;
        }

        if (routeConfig.api_key_env !== undefined) break;
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
