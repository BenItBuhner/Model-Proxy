/**
 * Core fallback router implementation.
 * Handles multi-level routing with API key, provider, and logical model fallbacks.
 */
import { KeyCycleTracker, getAvailableKeys } from "../core/api-key-manager.ts";
import { getProviderConfig, getProviderWireProtocol } from "../core/provider-config.ts";
import { env } from "../core/env.ts";
import { configLoader } from "./config-loader.ts";
import { RouteExecutionError, RouteExecutor, getExecutor } from "./executor.ts";
import {
  RoutingError,
  type Attempt,
  type ModelRoutingConfig,
  type ResolvedRoute,
  type RouteConfig,
  type WireProtocol,
} from "../types/routing.ts";

type RouteConfigTuple = [RouteConfig, boolean, string]; // [config, isFallback, sourceModel]

// ── Tool Response Fixers ──────────────────────────────────────────

function fixMissingToolResponses(requestData: Record<string, any>): Record<string, any> {
  const messages = requestData.messages;
  if (!Array.isArray(messages) || messages.length === 0) return requestData;

  const fixed: Record<string, any>[] = [];
  let pending: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.tool_calls) {
      if (pending.length > 0) {
        for (const id of pending) fixed.push({ role: "tool", tool_call_id: id, content: "" });
        pending = [];
      }
      fixed.push(msg);
      for (const tc of msg.tool_calls) { if (tc.id) pending.push(tc.id); }
    } else if (msg.role === "tool") {
      const idx = pending.indexOf(msg.tool_call_id);
      if (idx !== -1) pending.splice(idx, 1);
      fixed.push(msg);
    } else {
      if (pending.length > 0) {
        for (const id of pending) fixed.push({ role: "tool", tool_call_id: id, content: "" });
        pending = [];
      }
      fixed.push(msg);
    }
  }
  if (pending.length > 0) {
    for (const id of pending) fixed.push({ role: "tool", tool_call_id: id, content: "" });
  }

  return { ...requestData, messages: fixed };
}

function fixMissingToolResultsAnthropic(requestData: Record<string, any>): Record<string, any> {
  const messages = requestData.messages;
  if (!Array.isArray(messages) || messages.length === 0) return requestData;

  const extractToolUseIds = (content: any): string[] => {
    if (!Array.isArray(content)) return [];
    return content.filter((b: any) => b?.type === "tool_use" && b.id).map((b: any) => b.id);
  };

  const extractToolResultIds = (content: any): string[] => {
    if (!Array.isArray(content)) return [];
    return content.filter((b: any) => b?.type === "tool_result" && b.tool_use_id).map((b: any) => b.tool_use_id);
  };

  const makeToolResultMessage = (ids: string[]) => ({
    role: "user",
    content: ids.map(id => ({ type: "tool_result", tool_use_id: id, content: "", is_error: false })),
  });

  const fixed: Record<string, any>[] = [];
  let pending: string[] = [];

  for (const msg of messages) {
    if (msg.role === "assistant") {
      if (pending.length > 0) { fixed.push(makeToolResultMessage(pending)); pending = []; }
      fixed.push(msg);
      pending = extractToolUseIds(msg.content);
    } else if (msg.role === "user") {
      if (pending.length > 0) {
        const resolved = new Set(extractToolResultIds(msg.content));
        const missing = pending.filter(id => !resolved.has(id));
        if (missing.length > 0) fixed.push(makeToolResultMessage(missing));
        pending = [];
      }
      fixed.push(msg);
    } else {
      if (pending.length > 0) { fixed.push(makeToolResultMessage(pending)); pending = []; }
      fixed.push(msg);
    }
  }
  if (pending.length > 0) fixed.push(makeToolResultMessage(pending));

  return { ...requestData, messages: fixed };
}

// ── Fallback Router ───────────────────────────────────────────────

export class FallbackRouter {
  private _visitedModels: Set<string> = new Set();
  private _executor: RouteExecutor;
  private _modelConfigCache: Map<string, ModelRoutingConfig> = new Map();

  constructor(executor?: RouteExecutor) {
    this._executor = executor || getExecutor();
  }

  resolveErrorAction(providerName: string, error: unknown): Record<string, any> {
    let statusCode: number | null = null;
    const e = error as any;
    if (e?.status != null) statusCode = e.status;
    else if (e?.statusCode != null) statusCode = e.statusCode;
    else if (e instanceof RouteExecutionError && e.statusCode != null) statusCode = e.statusCode;

    if (statusCode == null) return { action: "model_key_failure" };
    if (typeof statusCode !== "number") {
      try { statusCode = parseInt(String(statusCode), 10); } catch { return { action: "model_key_failure" }; }
      if (isNaN(statusCode)) return { action: "model_key_failure" };
    }

    const config = getProviderConfig(providerName);
    const errorHandling = (config as any)?.error_handling || {};
    const actionInfo = errorHandling[String(statusCode)];
    if (actionInfo) return actionInfo;

    if (statusCode === 401 || statusCode === 403) return { action: "global_key_failure" };
    return { action: "model_key_failure" };
  }

  private createTrackerForRoute(
    routeConfig: RouteConfig,
    modelConfig: ModelRoutingConfig,
    maxKeyCycles?: number
  ): KeyCycleTracker {
    const providerConfig = getProviderConfig(routeConfig.provider);
    const providerCooldown = (providerConfig as any)?.rate_limiting?.cooldown_seconds;
    const routeCooldown = routeConfig.cooldown_seconds || modelConfig.default_cooldown_seconds;

    return new KeyCycleTracker({
      provider: routeConfig.provider,
      model: routeConfig.model,
      maxCycles: maxKeyCycles,
      providerCooldown,
      routeCooldown,
    });
  }

  async callWithFallback(
    logicalModel: string,
    requestData: Record<string, any>,
    targetProtocol: WireProtocol,
    stream: boolean = false,
    maxKeyCycles?: number
  ): Promise<any> {
    const routeConfigs = this.collectRouteConfigs(logicalModel);
    if (routeConfigs.length === 0) {
      throw new RoutingError({
        logicalModel,
        attemptedRoutes: [],
        errors: [{ error: "No routes available", error_type: "NoRoutesError" }],
        message: `No routes available for logical model '${logicalModel}'`,
      });
    }

    if (stream) {
      return this.streamWithFallbackDynamic(routeConfigs, requestData, targetProtocol, logicalModel, maxKeyCycles);
    }

    const errors: Record<string, any>[] = [];
    const allAttempts: Attempt[] = [];
    let attemptNumber = 1;

    for (const [routeConfig, isFallback, sourceModel] of routeConfigs) {
      if (!this._modelConfigCache.has(sourceModel)) {
        this._modelConfigCache.set(sourceModel, configLoader.loadConfig(sourceModel));
      }
      const modelConfig = this._modelConfigCache.get(sourceModel)!;
      const tracker = this.createTrackerForRoute(routeConfig, modelConfig, maxKeyCycles);

      if (tracker.allKeysInCooldown()) continue;

      while (!tracker.exhausted()) {
        const apiKey = tracker.getNextKey();
        if (!apiKey) break;

        const resolvedRoute = this.buildResolvedRoute(routeConfig, sourceModel, apiKey);
        const attempt: Attempt = { route: resolvedRoute, attemptNumber, isFallbackRoute: isFallback };
        allAttempts.push(attempt);

        try {
          const result = await this._executor.execute(resolvedRoute, requestData, targetProtocol);
          console.log(`[OK] Request succeeded: ${logicalModel} -> ${resolvedRoute.provider}/${resolvedRoute.model} (attempt ${attemptNumber})`);
          return result;
        } catch (e: any) {
          const actionInfo = this.resolveErrorAction(resolvedRoute.provider, e);
          const action = actionInfo.action || "model_key_failure";
          const errorInfo = {
            attempt: attemptNumber,
            provider: resolvedRoute.provider,
            model: resolvedRoute.model,
            error: String(e),
            error_type: e?.constructor?.name || "Error",
          };

          if (action === "fallback_no_cooldown") {
            errors.push(errorInfo);
            attemptNumber++;
            break;
          }

          if (action === "auto_fix_tool_responses") {
            const fixed = targetProtocol === "anthropic"
              ? fixMissingToolResultsAnthropic(requestData)
              : fixMissingToolResponses(requestData);
            try {
              const result = await this._executor.execute(resolvedRoute, fixed, targetProtocol);
              console.log(`[OK] Request succeeded (auto-fixed): ${logicalModel} -> ${resolvedRoute.provider}/${resolvedRoute.model}`);
              return result;
            } catch (retryError: any) {
              errorInfo.error = String(retryError);
              errors.push(errorInfo);
              attemptNumber++;
              break;
            }
          }

          tracker.markFailed(apiKey, action, { cooldownDuration: actionInfo.cooldown_seconds });

          if (this.isFallbackWorthyError(e)) {
            errors.push(errorInfo);
            attemptNumber++;
            continue;
          } else throw e;
        }

        attemptNumber++;
      }
    }

    throw new RoutingError({
      logicalModel,
      attemptedRoutes: allAttempts,
      errors,
      message: `All routes failed for logical model '${logicalModel}'`,
    });
  }

  private async *streamWithFallbackDynamic(
    routeConfigs: RouteConfigTuple[],
    requestData: Record<string, any>,
    targetProtocol: WireProtocol,
    logicalModel: string,
    maxKeyCycles?: number
  ): AsyncGenerator<string, void, unknown> {
    const errors: Record<string, any>[] = [];
    const allAttempts: Attempt[] = [];
    let attemptNumber = 1;

    for (const [routeConfig, isFallback, sourceModel] of routeConfigs) {
      if (!this._modelConfigCache.has(sourceModel)) {
        this._modelConfigCache.set(sourceModel, configLoader.loadConfig(sourceModel));
      }
      const modelConfig = this._modelConfigCache.get(sourceModel)!;
      const tracker = this.createTrackerForRoute(routeConfig, modelConfig, maxKeyCycles);

      if (tracker.allKeysInCooldown()) continue;

      while (!tracker.exhausted()) {
        const apiKey = tracker.getNextKey();
        if (!apiKey) break;

        const resolvedRoute = this.buildResolvedRoute(routeConfig, sourceModel, apiKey);
        const attempt: Attempt = { route: resolvedRoute, attemptNumber, isFallbackRoute: isFallback };
        allAttempts.push(attempt);

        try {
          const streamGen = this._executor.executeStream(resolvedRoute, requestData, targetProtocol);
          for await (const chunk of streamGen) yield chunk;
          console.log(`[OK] Stream succeeded: ${logicalModel} -> ${resolvedRoute.provider}/${resolvedRoute.model}`);
          return;
        } catch (e: any) {
          const actionInfo = this.resolveErrorAction(resolvedRoute.provider, e);
          const action = actionInfo.action || "model_key_failure";
          const errorInfo = {
            attempt: attemptNumber,
            provider: resolvedRoute.provider,
            model: resolvedRoute.model,
            error: String(e),
            error_type: e?.constructor?.name || "Error",
          };

          if (action === "fallback_no_cooldown") {
            errors.push(errorInfo);
            attemptNumber++;
            break;
          }

          if (action === "auto_fix_tool_responses") {
            const fixed = targetProtocol === "anthropic"
              ? fixMissingToolResultsAnthropic(requestData)
              : fixMissingToolResponses(requestData);
            try {
              const gen = this._executor.executeStream(resolvedRoute, fixed, targetProtocol);
              for await (const chunk of gen) yield chunk;
              return;
            } catch {
              errors.push(errorInfo);
              attemptNumber++;
              break;
            }
          }

          tracker.markFailed(apiKey, action, { cooldownDuration: actionInfo.cooldown_seconds });

          if (this.isFallbackWorthyError(e)) {
            errors.push(errorInfo);
            attemptNumber++;
            continue;
          } else throw e;
        }

        attemptNumber++;
      }
    }

    throw new RoutingError({
      logicalModel,
      attemptedRoutes: allAttempts,
      errors,
      message: `All routes failed for logical model '${logicalModel}'`,
    });
  }

  private collectRouteConfigs(logicalModel: string): RouteConfigTuple[] {
    this._visitedModels.clear();
    return this.collectRouteConfigsRecursive(logicalModel, false);
  }

  private collectRouteConfigsRecursive(logicalModel: string, isFallback: boolean): RouteConfigTuple[] {
    if (this._visitedModels.has(logicalModel)) return [];
    this._visitedModels.add(logicalModel);

    let config: ModelRoutingConfig;
    try { config = configLoader.loadConfig(logicalModel); } catch { this._visitedModels.delete(logicalModel); return []; }

    const routes: RouteConfigTuple[] = [];
    for (const rc of config.model_routings) routes.push([rc, isFallback, logicalModel]);
    for (const fallback of config.fallback_model_routings) {
      routes.push(...this.collectRouteConfigsRecursive(fallback, true));
    }

    this._visitedModels.delete(logicalModel);
    return routes;
  }

  private buildResolvedRoute(routeConfig: RouteConfig, sourceModel: string, apiKey: string): ResolvedRoute {
    const wireProtocol = routeConfig.wire_protocol || getProviderWireProtocol(routeConfig.provider);
    return {
      sourceLogicalModel: sourceModel,
      wireProtocol,
      provider: routeConfig.provider,
      model: routeConfig.model,
      baseUrl: routeConfig.base_url,
      apiKey,
      timeoutSeconds: routeConfig.timeout_seconds || 60,
    };
  }

  private isFallbackWorthyError(error: unknown): boolean {
    const e = error as any;
    const status = e?.status ?? e?.statusCode;
    if (status != null) {
      const s = typeof status === "number" ? status : parseInt(String(status), 10);
      if (!isNaN(s) && s >= 400 && s < 600) return true;
    }
    if (e instanceof RouteExecutionError) {
      if (e.statusCode && e.statusCode >= 400 && e.statusCode < 600) return true;
      return true;
    }

    const msg = String(e?.message || e || "").toLowerCase();
    const indicators = ["timeout", "connection", "network", "unreachable", "reset", "server error",
      "bad gateway", "service unavailable", "gateway timeout", "rate limit", "overloaded"];
    return indicators.some(i => msg.includes(i));
  }
}

// Convenience function
export async function callWithFallback(
  logicalModel: string,
  requestData: Record<string, any>,
  targetProtocol: WireProtocol,
  stream: boolean = false,
  maxKeyCycles?: number
): Promise<any> {
  const router = new FallbackRouter();
  return router.callWithFallback(logicalModel, requestData, targetProtocol, stream, maxKeyCycles);
}
