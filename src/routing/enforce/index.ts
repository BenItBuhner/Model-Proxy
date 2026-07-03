import { createLogger } from "../../observability/logger.ts";
import { emit, nowIso } from "../../observability/request-context.ts";
import type { Principal } from "../../storage/identity-store.ts";
import type { FallbackRouter } from "../fallback.ts";
import { resolveEnforceConfig, type PerRequestOverrides } from "./config.ts";
import { injectGuidance } from "./injector.ts";
import { scrubRetryMarkers, withRetryCorrection } from "./retry.ts";
import { emulateStream } from "./stream-emulator.ts";
import {
  responseContainsFlag,
  stripTerminationFlag,
} from "./stripper.ts";
import type { EnforceProtocol, ResolvedEnforceConfig } from "./types.ts";
import {
  isEmptyContentResponse,
  validateResponse,
} from "./validator.ts";
import type { EnforceToolCallConfig } from "../../../shared/schemas/enforce.ts";
import { modelConfigLoader } from "../../config/model-loader.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contentBecameNull(
  response: Record<string, unknown>,
  protocol: EnforceProtocol,
): boolean {
  if (protocol === "openai") {
    const choices = response["choices"];
    if (!Array.isArray(choices)) return false;
    const first = choices[0];
    if (!isObject(first)) return false;
    const message = first["message"];
    if (!isObject(message)) return false;
    return message["content"] === null;
  }
  const content = response["content"];
  return Array.isArray(content) && content.length === 0;
}

function hasToolCalls(
  response: Record<string, unknown>,
  protocol: EnforceProtocol,
): boolean {
  if (protocol === "openai") {
    const choices = response["choices"];
    if (!Array.isArray(choices)) return false;
    const first = choices[0];
    if (!isObject(first)) return false;
    const message = first["message"];
    if (!isObject(message)) return false;
    const tc = message["tool_calls"];
    return Array.isArray(tc) && tc.length > 0;
  }
  const content = response["content"];
  if (!Array.isArray(content)) return false;
  return content.some((b) => isObject(b) && b["type"] === "tool_use");
}

const log = createLogger("enforce");

export class EnforceValidationError extends Error {
  readonly attempts: number;
  readonly lastReason: string;
  constructor(attempts: number, lastReason: string) {
    super(`Validation failed after ${attempts} attempts: ${lastReason}`);
    this.name = "EnforceValidationError";
    this.attempts = attempts;
    this.lastReason = lastReason;
  }
}

export interface EnforceCallArgs {
  logicalModel: string;
  requestData: Record<string, unknown>;
  targetProtocol: EnforceProtocol;
  signal?: AbortSignal;
  principal?: Principal;
  /** Extra headers forwarded to upstream providers (e.g. x-opencode-*). */
  extraHeaders?: Record<string, string>;
  /** Optional per-request overrides (header / query). */
  overrides?: PerRequestOverrides;
}

/**
 * Wrapper around `FallbackRouter` that enforces tool-call / termination-flag
 * contracts with per-model configuration, retries without context bloat, and
 * emulated streaming that piggybacks on a validated non-streaming response.
 */
export class EnforceRouter {
  constructor(private readonly fallbackRouter: FallbackRouter) {}

  resolveConfig(args: {
    logicalModel: string;
    overrides?: PerRequestOverrides;
  }): ResolvedEnforceConfig {
    let perModel: EnforceToolCallConfig | undefined;
    try {
      const modelConfig = modelConfigLoader.loadConfig(args.logicalModel);
      perModel = modelConfig.enforce_tool_call;
    } catch {
      perModel = undefined;
    }
    return resolveEnforceConfig(perModel, args.overrides ?? {});
  }

  async call(args: EnforceCallArgs): Promise<Record<string, unknown>> {
    const config = this.resolveConfig(args);
    if (!config.enabled) {
      return await this.fallbackRouter.callWithFallback({
        logicalModel: args.logicalModel,
        requestData: scrubRetryMarkers(args.requestData),
        targetProtocol: args.targetProtocol,
        ...(args.principal !== undefined ? { principal: args.principal } : {}),
        ...(args.signal !== undefined ? { signal: args.signal } : {}),
        ...(args.extraHeaders !== undefined ? { extraHeaders: args.extraHeaders } : {}),
      });
    }

    const injected = injectGuidance(
      args.requestData,
      config.guidance,
      args.targetProtocol,
    );
    emit({
      type: "enforce.injected",
      at: nowIso(),
      guidanceLength: config.guidance.length,
      protocol: args.targetProtocol,
    });
    const validated = await this.callWithValidation(
      args.logicalModel,
      injected,
      args.targetProtocol,
      args.signal,
      args.extraHeaders,
      args.principal,
      config,
    );
    const hadFlag = responseContainsFlag(
      validated,
      config.terminationFlag,
      args.targetProtocol,
    );
    const tools = hasToolCalls(validated, args.targetProtocol);
    const stripped = stripTerminationFlag(
      validated,
      config.terminationFlag,
      args.targetProtocol,
    );
    if (hadFlag) {
      emit({
        type: "enforce.stripped",
        at: nowIso(),
        contentBecameNull: contentBecameNull(stripped, args.targetProtocol),
        toolCallsPreserved: tools,
      });
    }
    return stripped;
  }

  async *stream(args: EnforceCallArgs): AsyncGenerator<string, void, unknown> {
    const config = this.resolveConfig(args);
    if (!config.enabled) {
      const streamArgs: Parameters<FallbackRouter["streamWithFallback"]>[0] = {
        logicalModel: args.logicalModel,
        requestData: scrubRetryMarkers(args.requestData),
        targetProtocol: args.targetProtocol,
      };
      if (args.signal !== undefined) streamArgs.signal = args.signal;
      if (args.extraHeaders !== undefined) streamArgs.extraHeaders = args.extraHeaders;
      if (args.principal !== undefined) streamArgs.principal = args.principal;
      for await (const chunk of this.fallbackRouter.streamWithFallback(streamArgs)) {
        yield chunk;
      }
      return;
    }

    const injected = injectGuidance(
      args.requestData,
      config.guidance,
      args.targetProtocol,
    );
    emit({
      type: "enforce.injected",
      at: nowIso(),
      guidanceLength: config.guidance.length,
      protocol: args.targetProtocol,
    });
    const validated = await this.callWithValidation(
      args.logicalModel,
      injected,
      args.targetProtocol,
      args.signal,
      args.extraHeaders,
      args.principal,
      config,
    );
    const hadFlag = responseContainsFlag(
      validated,
      config.terminationFlag,
      args.targetProtocol,
    );
    const tools = hasToolCalls(validated, args.targetProtocol);
    const stripped = stripTerminationFlag(
      validated,
      config.terminationFlag,
      args.targetProtocol,
    );
    if (hadFlag) {
      emit({
        type: "enforce.stripped",
        at: nowIso(),
        contentBecameNull: contentBecameNull(stripped, args.targetProtocol),
        toolCallsPreserved: tools,
      });
    }

    const modelHint =
      typeof args.requestData["model"] === "string"
        ? (args.requestData["model"] as string)
        : args.logicalModel;

    yield* emulateStream(stripped, args.targetProtocol, {
      chunkDelayMs: config.streamChunkDelayMs,
      modelFallback: modelHint,
    });
  }

  private async callWithValidation(
    logicalModel: string,
    seedRequest: Record<string, unknown>,
    protocol: EnforceProtocol,
    signal: AbortSignal | undefined,
    extraHeaders: Record<string, string> | undefined,
    principal: Principal | undefined,
    config: ResolvedEnforceConfig,
  ): Promise<Record<string, unknown>> {
    let currentRequest = seedRequest;
    let lastReason = "no attempt completed";

    for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
      log.info("enforce attempt", {
        logicalModel,
        protocol,
        attempt,
        maxRetries: config.maxRetries,
      });
      emit({
        type: "enforce.attempt",
        at: nowIso(),
        attempt,
        maxRetries: config.maxRetries,
      });

      const response = await this.fallbackRouter.callWithFallback({
        logicalModel,
        requestData: scrubRetryMarkers(currentRequest),
        targetProtocol: protocol,
        validateResponse: false,
        ...(principal !== undefined ? { principal } : {}),
        ...(signal !== undefined ? { signal } : {}),
        ...(extraHeaders !== undefined ? { extraHeaders } : {}),
      });

      // 1. Explicit empty/whitespace guard — catches the null/empty-content bug.
      if (
        config.emptyResponsePolicy === "strict" &&
        isEmptyContentResponse(response, protocol)
      ) {
        lastReason =
          "response contained no tool_calls and all content was empty or whitespace";
        log.warn("enforce retry (empty response)", {
          logicalModel,
          attempt,
        });
        emit({
          type: "enforce.empty_response",
          at: nowIso(),
          attempt,
          policy: config.emptyResponsePolicy,
        });
        emit({
          type: "enforce.retry",
          at: nowIso(),
          attempt,
          reason: lastReason,
        });
        currentRequest = withRetryCorrection(currentRequest, lastReason, protocol);
        continue;
      }

      // 2. Standard validator — checks for tool_calls OR termination flag.
      const result = validateResponse(response, protocol, config.terminationFlag);
      if (result.valid) {
        log.info("enforce validated", {
          logicalModel,
          attempt,
          kind: result.responseType,
        });
        emit({
          type: "enforce.validated",
          at: nowIso(),
          attempt,
          kind: result.responseType === "termination" ? "termination" : "tool_calls",
        });
        return response;
      }

      lastReason = result.reason;
      log.warn("enforce validation failed", {
        logicalModel,
        attempt,
        reason: result.reason,
      });
      emit({
        type: "enforce.retry",
        at: nowIso(),
        attempt,
        reason: lastReason,
      });
      currentRequest = withRetryCorrection(currentRequest, lastReason, protocol);
    }

    throw new EnforceValidationError(config.maxRetries, lastReason);
  }
}

export type { PerRequestOverrides, ResolvedEnforceConfig };
