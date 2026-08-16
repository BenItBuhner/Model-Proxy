import type {
  ProviderCallContext,
  ResponsesCallArgs,
} from "./base.ts";
import { OpenAIProvider } from "./openai-provider.ts";

/** xAI subscription transport used by Grok CLI / SuperGrok OAuth tokens. */
export class SuperGrokProvider extends OpenAIProvider {
  constructor() {
    super("supergrok");
  }

  protected override openAIRequestHeaders(
    ctx: ProviderCallContext,
    accept: string,
  ): Record<string, string> {
    return {
      ...super.openAIRequestHeaders(ctx, accept),
      "x-grok-client-version":
        process.env["SUPERGROK_CLIENT_VERSION"]?.trim() || "0.2.101",
      "x-grok-client-mode": "api",
      "User-Agent": "grok-cli/0.2.101 (model-proxy/2.0)",
    };
  }

  protected override buildResponsesPayload(
    args: ResponsesCallArgs,
  ): Record<string, unknown> {
    return { ...args, model: args.model, store: false };
  }
}
