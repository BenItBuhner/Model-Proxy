import { describe, expect, test } from "bun:test";

import type { ProviderCallContext } from "../src/providers/base.ts";
import { OpenCodeProvider } from "../src/providers/opencode-provider.ts";
import { buildAuthHeaders } from "../src/providers/provider-helpers.ts";

describe("OpenCodeProvider", () => {
  test("uses Bearer public when api key is empty", () => {
    const provider = new OpenCodeProvider();
    const ctx: ProviderCallContext = {
      apiKey: "public",
      baseUrlOverride: undefined,
      timeoutSeconds: 60,
      signal: undefined,
    };
    const headers = provider["authHeaders"](ctx);
    expect(headers["Authorization"]).toBe("Bearer public");
  });

  test("buildAuthHeaders with public default matches provider config", () => {
    const provider = new OpenCodeProvider();
    const headers = buildAuthHeaders(provider.config, "public");
    expect(headers["Authorization"]).toBe("Bearer public");
  });

  test("attaches zen headers from extraHeaders and defaults", () => {
    const provider = new OpenCodeProvider();
    const ctx: ProviderCallContext = {
      apiKey: "public",
      baseUrlOverride: undefined,
      timeoutSeconds: 60,
      signal: undefined,
      extraHeaders: {
        "x-opencode-session": "sess-123",
        "x-opencode-request": "req-456",
        "x-opencode-client": "opencode-cli",
      },
    };
    const headers = provider["openAIRequestHeaders"](ctx, "application/json");
    expect(headers["Authorization"]).toBe("Bearer public");
    expect(headers["x-opencode-session"]).toBe("sess-123");
    expect(headers["x-opencode-request"]).toBe("req-456");
    expect(headers["x-opencode-client"]).toBe("opencode-cli");
    expect(headers["User-Agent"]).toContain("model-proxy/");
  });
});
