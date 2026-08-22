import type {
  ProviderCallContext,
  ResponsesCallArgs,
} from "./base.ts";
import { OpenAIProvider } from "./openai-provider.ts";

/** ChatGPT subscription transport used by the official Codex CLI. */
export class CodexProvider extends OpenAIProvider {
  constructor() {
    super("codex");
  }

  protected override openAIRequestHeaders(
    ctx: ProviderCallContext,
    accept: string,
  ): Record<string, string> {
    return {
      ...super.openAIRequestHeaders(ctx, accept),
      originator: "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.101.0 (model-proxy/2.0)",
    };
  }

  protected override buildResponsesPayload(
    args: ResponsesCallArgs,
  ): Record<string, unknown> {
    // The ChatGPT subscription surface is stateless from the proxy's point of
    // view. Model-Proxy owns response storage and previous_response_id chains.
    return { ...args, model: args.model, store: false };
  }
}
