/**
 * Base provider class defining the interface for all LLM providers.
 * Enhanced with route configuration injection for fallback routing support.
 */
import { getApiKey, markKeyFailed } from "../core/api-key-manager.ts";

export class ProviderAPIError extends Error {
  status: number;
  body: string | null;

  constructor(message: string, status: number, body?: string | null) {
    super(message);
    this.name = "ProviderAPIError";
    this.status = typeof status === "number" ? status : 500;
    this.body = body ?? null;
  }
}

export abstract class BaseProvider {
  providerName: string;
  protected _routeApiKey: string | null = null;
  protected _routeBaseUrl: string | null = null;

  constructor(providerName: string) {
    this.providerName = providerName;
  }

  setRouteConfig(apiKey?: string | null, baseUrl?: string | null): this {
    this._routeApiKey = apiKey ?? null;
    this._routeBaseUrl = baseUrl ?? null;
    return this;
  }

  clearRouteConfig(): this {
    this._routeApiKey = null;
    this._routeBaseUrl = null;
    return this;
  }

  protected getEffectiveApiKey(): string | null {
    if (this._routeApiKey) return this._routeApiKey;
    return getApiKey(this.providerName);
  }

  protected getEffectiveBaseUrl(defaultBaseUrl: string): string {
    if (this._routeBaseUrl) return this._routeBaseUrl;
    return defaultBaseUrl;
  }

  protected markKeyFailed(key: string): void {
    markKeyFailed(this.providerName, key);
  }

  abstract call(model: string, request: Record<string, any>): Promise<Record<string, any>>;

  abstract callStream(model: string, request: Record<string, any>): AsyncGenerator<string, void, unknown>;
}
