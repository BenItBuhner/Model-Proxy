/**
 * Route Executor - Executes resolved routes with automatic protocol conversion.
 */
import {
  anthropicToOpenaiRequest,
  anthropicToOpenaiResponse,
  openaiToAnthropicRequest,
  openaiToAnthropicResponse,
} from "../core/format-converters.ts";
import { createProvider } from "../providers/registry.ts";
import type { ResolvedRoute, WireProtocol } from "../types/routing.ts";
import { env } from "../core/env.ts";

export class RouteExecutionError extends Error {
  route: ResolvedRoute;
  originalError: Error | null;
  statusCode: number | null;
  status: number | null; // Alias for compatibility

  constructor(message: string, route: ResolvedRoute, originalError?: Error | null, statusCode?: number | null) {
    super(message);
    this.name = "RouteExecutionError";
    this.route = route;
    this.originalError = originalError ?? null;

    // Extract status from original error
    let sc = statusCode ?? null;
    if (sc == null && originalError) {
      sc = (originalError as any).status ?? (originalError as any).statusCode ?? null;
    }
    this.statusCode = sc;
    this.status = sc;
  }
}

export class RouteExecutor {
  async execute(
    route: ResolvedRoute,
    requestData: Record<string, any>,
    targetProtocol: WireProtocol
  ): Promise<Record<string, any>> {
    const sourceProtocol = route.wireProtocol;

    try {
      const provider = createProvider(route.provider, route.apiKey, route.baseUrl);

      // Convert request if protocols differ
      let convertedRequest = requestData;
      if (sourceProtocol !== targetProtocol) {
        convertedRequest = this.convertRequest(requestData, targetProtocol, sourceProtocol);
      }

      // Execute the call
      const response = await this.callProvider(provider, route, convertedRequest, sourceProtocol);

      // Convert response back if protocols differ
      if (sourceProtocol !== targetProtocol) {
        const modelName = requestData.model || route.model;
        return this.convertResponse(response, sourceProtocol, targetProtocol, modelName);
      }

      return response;
    } catch (e: any) {
      if (e instanceof RouteExecutionError) throw e;
      throw new RouteExecutionError(
        `Failed: provider=${route.provider}, model=${route.model}`,
        route,
        e
      );
    }
  }

  async *executeStream(
    route: ResolvedRoute,
    requestData: Record<string, any>,
    targetProtocol: WireProtocol
  ): AsyncGenerator<string, void, unknown> {
    const sourceProtocol = route.wireProtocol;

    try {
      const provider = createProvider(route.provider, route.apiKey, route.baseUrl);

      // Convert request if protocols differ
      let convertedRequest = requestData;
      if (sourceProtocol !== targetProtocol) {
        convertedRequest = this.convertRequest(requestData, targetProtocol, sourceProtocol);
      }

      // Execute the streaming call
      yield* this.callProviderStream(provider, route, convertedRequest, sourceProtocol);
    } catch (e: any) {
      if (e instanceof RouteExecutionError) throw e;
      throw new RouteExecutionError(
        `Stream failed: provider=${route.provider}, model=${route.model}`,
        route,
        e
      );
    }
  }

  private convertRequest(
    requestData: Record<string, any>,
    fromProtocol: WireProtocol,
    toProtocol: WireProtocol
  ): Record<string, any> {
    if (fromProtocol === toProtocol) return requestData;
    if (fromProtocol === "anthropic" && toProtocol === "openai") return anthropicToOpenaiRequest(requestData);
    if (fromProtocol === "openai" && toProtocol === "anthropic") return openaiToAnthropicRequest(requestData);
    return requestData;
  }

  private convertResponse(
    response: Record<string, any>,
    fromProtocol: WireProtocol,
    toProtocol: WireProtocol,
    modelName: string
  ): Record<string, any> {
    if (fromProtocol === toProtocol) return response;
    if (fromProtocol === "openai" && toProtocol === "anthropic") return openaiToAnthropicResponse(response, modelName);
    if (fromProtocol === "anthropic" && toProtocol === "openai") return anthropicToOpenaiResponse(response, modelName);
    return response;
  }

  private async callProvider(
    provider: any,
    route: ResolvedRoute,
    request: Record<string, any>,
    protocol: WireProtocol
  ): Promise<Record<string, any>> {
    if (protocol === "anthropic") {
      return provider.call(route.model, {
        messages: request.messages || [],
        max_tokens: request.max_tokens || 4096,
        temperature: request.temperature,
        top_p: request.top_p,
        top_k: request.top_k,
        tools: request.tools,
        system: request.system,
      });
    }

    // OpenAI protocol
    return provider.call(route.model, {
      messages: request.messages || [],
      temperature: request.temperature,
      top_p: request.top_p,
      n: request.n,
      stop: request.stop,
      max_tokens: request.max_tokens,
      presence_penalty: request.presence_penalty,
      logit_bias: request.logit_bias,
      user: request.user,
      tools: request.tools,
      tool_choice: request.tool_choice,
    });
  }

  private async *callProviderStream(
    provider: any,
    route: ResolvedRoute,
    request: Record<string, any>,
    protocol: WireProtocol
  ): AsyncGenerator<string, void, unknown> {
    if (protocol === "anthropic") {
      yield* provider.callStream(route.model, {
        messages: request.messages || [],
        max_tokens: request.max_tokens || 4096,
        temperature: request.temperature,
        top_p: request.top_p,
        top_k: request.top_k,
        tools: request.tools,
        system: request.system,
      });
    } else {
      yield* provider.callStream(route.model, {
        messages: request.messages || [],
        temperature: request.temperature,
        top_p: request.top_p,
        n: request.n,
        stop: request.stop,
        max_tokens: request.max_tokens,
        presence_penalty: request.presence_penalty,
        logit_bias: request.logit_bias,
        user: request.user,
        tools: request.tools,
        tool_choice: request.tool_choice,
      });
    }
  }
}

// Singleton
let _executor: RouteExecutor | null = null;

export function getExecutor(): RouteExecutor {
  if (!_executor) _executor = new RouteExecutor();
  return _executor;
}
