/**
 * Provider-level error with an HTTP status code. Used by the fallback router
 * to decide which errors warrant moving to the next route.
 */
export class ProviderAPIError extends Error {
  readonly status: number;
  readonly body: string | undefined;
  readonly provider: string | undefined;

  constructor(
    message: string,
    status: number,
    options: { body?: string; provider?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderAPIError";
    this.status = Number.isInteger(status) ? status : 500;
    this.body = options.body;
    this.provider = options.provider;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Thrown when no API keys are available for a provider. */
export class NoApiKeysError extends Error {
  constructor(provider: string) {
    super(`No API keys available for provider '${provider}'`);
    this.name = "NoApiKeysError";
  }
}

/** Thrown by the executor when a provider call fails catastrophically. */
export class RouteExecutionError extends Error {
  readonly statusCode: number | undefined;
  readonly originalError: unknown;

  constructor(
    message: string,
    options: { statusCode?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "RouteExecutionError";
    this.statusCode = options.statusCode;
    this.originalError = options.cause;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
