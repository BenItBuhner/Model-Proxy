import { OpenAIProvider } from "./openai-provider.ts";

/**
 * Gemini exposed via its OpenAI-compatible endpoint. The base OpenAIProvider
 * already handles the Gemini-specific payload quirks by provider name.
 */
export class GeminiOpenAIProvider extends OpenAIProvider {
  constructor(providerName = "gemini") {
    super(providerName);
  }
}
