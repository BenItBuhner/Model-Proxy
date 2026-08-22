import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { modelConfigLoader } from "../src/config/model-loader.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { resetKeyState } from "../src/providers/api-key-manager.ts";
import { createApp } from "../src/server/app.ts";
import { createAccount } from "../src/storage/account-store.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const root = join(tmpdir(), `mp-codex-routing-${process.pid}-${Date.now()}`);
let upstream: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "providers"), { recursive: true });
  mkdirSync(join(root, "models"), { recursive: true });
  setPrimaryConfigDirForTests(root);
  setStorageRootForTests(join(root, ".storage"));
  closeOperationalDbForTests();
  resetKeyState();
  process.env.CLIENT_API_KEY = "routing-client-key";
});

afterEach(() => {
  upstream?.stop(true);
  upstream = undefined;
  delete process.env.CLIENT_API_KEY;
  resetKeyState();
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  setPrimaryConfigDirForTests(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("Codex subscription account routing", () => {
  test("rotates attached accounts and sends ChatGPT account identity", async () => {
    const seen: Array<{
      authorization: string | null;
      accountId: string | null;
      body: Record<string, unknown>;
    }> = [];
    upstream = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        const authorization = request.headers.get("authorization");
        seen.push({
          authorization,
          accountId: request.headers.get("chatgpt-account-id"),
          body,
        });
        if (authorization === "Bearer expired-seat") {
          return Response.json(
            { error: { message: "seat quota reached" } },
            { status: 429 },
          );
        }
        return Response.json({
          id: "resp_codex",
          object: "response",
          status: "completed",
          model: body["model"],
          output: [
            {
              id: "msg_1",
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "second seat succeeded" }],
            },
          ],
        });
      },
    });

    writeFileSync(
      join(root, "providers", "codex.json"),
      JSON.stringify({
        name: "codex",
        api_keys: { env_var_patterns: [] },
        endpoints: {
          base_url: `http://127.0.0.1:${upstream.port}`,
          completions: "/responses",
          responses: "/responses",
          responses_streaming: "/responses",
          compatible_format: "responses",
        },
        authentication: {
          type: "bearer",
          header_name: "Authorization",
          header_format: "Bearer {api_key}",
        },
        rate_limiting: { enabled: false, cooldown_seconds: 1 },
        error_handling: {
          "429": { action: "model_key_failure" },
        },
      }),
    );
    writeFileSync(
      join(root, "models", "codex-test.json"),
      JSON.stringify({
        logical_name: "codex-test",
        timeout_seconds: 5,
        default_cooldown_seconds: 1,
        model_routings: [
          {
            provider: "codex",
            model: "gpt-5.4",
            wire_protocol: "responses",
            base_url: `http://127.0.0.1:${upstream.port}`,
          },
        ],
        fallback_model_routings: [],
      }),
    );
    providerConfigLoader.clearCache();
    modelConfigLoader.clearCache();

    createAccount({
      provider: "codex",
      kind: "token",
      label: "seat one",
      accessToken: "expired-seat",
      accountId: "acct_one",
      shared: true,
    });
    createAccount({
      provider: "codex",
      kind: "token",
      label: "seat two",
      accessToken: "working-seat",
      accountId: "acct_two",
      shared: true,
    });

    const response = await createApp().request("/v1/responses", {
      method: "POST",
      headers: {
        authorization: "Bearer routing-client-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "codex-test",
        input: "hello",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      object: "response",
      status: "completed",
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({
      authorization: "Bearer expired-seat",
      accountId: "acct_one",
    });
    expect(seen[1]).toMatchObject({
      authorization: "Bearer working-seat",
      accountId: "acct_two",
    });
    expect(seen[1]?.body).toMatchObject({
      model: "gpt-5.4",
      store: false,
    });
  });
});
