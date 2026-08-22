/**
 * Provider-level error with an HTTP status code. Used by the fallback router
 * to decide which errors warrant moving to the next route.
 */
export class ProviderAPIError extends Error {
  readonly status: number;
  readonly body: string | undefined;
  readonly provider: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    status: number,
    options: {
      body?: string;
      provider?: string;
      cause?: unknown;
      retryAfterSeconds?: number;
    } = {},
  ) {
    super(message);
    this.name = "ProviderAPIError";
    this.status = Number.isInteger(status) ? status : 500;
    this.body = options.body;
    this.provider = options.provider;
    this.retryAfterSeconds = options.retryAfterSeconds;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** Raised when the proxy's own upstream timeout aborts a provider request. */
export class ProviderTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(
    message: string,
    timeoutMs: number,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ProviderTimeoutError";
    this.timeoutMs = timeoutMs;
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
