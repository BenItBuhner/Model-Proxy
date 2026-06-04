import type { ProviderCallContext } from "./base.ts";
import { OpenAIProvider } from "./openai-provider.ts";
import { buildAuthHeaders } from "./provider-helpers.ts";

const MODEL_PROXY_VERSION = "2.0.0";

/**
 * OpenCode Zen gateway provider. Uses Bearer `public` for free-tier models and
 * attaches the x-opencode-* headers expected by opencode.ai/zen.
 */
export class OpenCodeProvider extends OpenAIProvider {
  constructor() {
    super("opencode");
  }

  protected override authHeaders(ctx: ProviderCallContext): Record<string, string> {
    const key =
      ctx.apiKey.length > 0 && ctx.apiKey !== "(auto)" ? ctx.apiKey : "public";
    return buildAuthHeaders(this.config, key);
  }

  protected override openAIRequestHeaders(
    ctx: ProviderCallContext,
    accept: string,
  ): Record<string, string> {
    const zen = this.zenHeaders(ctx);
    return {
      ...this.authHeaders(ctx),
      ...zen,
      ...(ctx.extraHeaders ?? {}),
      "Content-Type": "application/json",
      Accept: accept,
    };
  }

  private zenHeaders(ctx: ProviderCallContext): Record<string, string> {
    const extra = ctx.extraHeaders ?? {};
    const headers: Record<string, string> = {};

    const session =
      extra["x-opencode-session"] ??
      extra["x-session-affinity"] ??
      crypto.randomUUID();
    headers["x-opencode-session"] = session;

    const requestId = extra["x-opencode-request"] ?? session;
    headers["x-opencode-request"] = requestId;

    headers["x-opencode-client"] = extra["x-opencode-client"] ?? "model-proxy";

    if (extra["x-opencode-project"] !== undefined) {
      headers["x-opencode-project"] = extra["x-opencode-project"];
    }

    headers["User-Agent"] =
      extra["User-Agent"] ?? extra["user-agent"] ?? `model-proxy/${MODEL_PROXY_VERSION}`;

    return headers;
  }
}
