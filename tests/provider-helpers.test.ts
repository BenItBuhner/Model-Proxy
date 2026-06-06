import { describe, expect, test } from "bun:test";

import { buildEndpointUrl } from "../src/providers/provider-helpers.ts";
import type { ProviderConfig } from "../shared/schemas/provider.ts";

function azureLikeConfig(): ProviderConfig {
  return {
    name: "azure",
    display_name: "Azure",
    enabled: true,
    api_keys: { env_var_patterns: ["AZURE_API_KEY"] },
    endpoints: {
      base_url: "https://example.openai.azure.com",
      completions:
        "openai/deployments/{model}/chat/completions?api-version=2024-02-15-preview",
      streaming:
        "openai/deployments/{model}/chat/completions?api-version=2024-02-15-preview",
      compatible_format: "openai",
    },
    authentication: {
      type: "api_key",
      header_name: "api-key",
      header_format: "{api_key}",
    },
    rate_limiting: { enabled: false, cooldown_seconds: 0 },
    request_config: { timeout_seconds: 60, max_retries: 3 },
    error_handling: {},
    model_mapping: {},
    models: {},
  } as ProviderConfig;
}

describe("buildEndpointUrl", () => {
  test("substitutes {model} and {{model}} in deployment paths", () => {
    const url = buildEndpointUrl(
      azureLikeConfig(),
      undefined,
      "completions",
      "minimax-m3",
    );
    expect(url).toBe(
      "https://example.openai.azure.com/openai/deployments/minimax-m3/chat/completions?api-version=2024-02-15-preview",
    );
  });
});
