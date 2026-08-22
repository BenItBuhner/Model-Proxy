import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { readConfigValues, upsertConfigValues } from "../src/config/config-store.ts";
import { setPrimaryConfigDirForTests } from "../src/config/paths.ts";
import { providerConfigLoader } from "../src/config/provider-loader.ts";
import { discoverProxies } from "../src/providers/proxy-discovery.ts";
import type { UpstreamFetcher } from "../src/providers/upstream-fetch.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const tmpRoot = join(tmpdir(), `mp-v2-proxy-discovery-${process.pid}-${Date.now()}`);

function provider(name: string, auth: "public" | "provider_key" = "provider_key") {
  return {
    name,
    display_name: name,
    enabled: true,
    api_keys: { env_var_patterns: [`${name.toUpperCase()}_API_KEY`] },
    endpoints: {
      base_url: `https://${name}.example/v1`,
      completions: "/chat/completions",
      compatible_format: "openai",
    },
    authentication: { type: "bearer", header_name: "Authorization", header_format: "Bearer {api_key}" },
    egress_proxies: {
      enabled: true,
      env_var_patterns: ["MODEL_PROXY_EGRESS_PROXY_{INDEX}"],
      verification: {
        enabled: true,
        url: `https://${name}.example/v1/models`,
        method: "GET",
        success_statuses: [200],
        timeout_ms: 1000,
        auth,
      },
    },
  };
}

beforeAll(() => {
  mkdirSync(join(tmpRoot, "providers"), { recursive: true });
  mkdirSync(join(tmpRoot, "models"), { recursive: true });
  setPrimaryConfigDirForTests(tmpRoot);
  setStorageRootForTests(join(tmpRoot, "storage"));
  (providerConfigLoader as unknown as { searchPaths: string[] }).searchPaths = [tmpRoot];
  writeFileSync(join(tmpRoot, "providers", "opencode.json"), JSON.stringify(provider("opencode", "public")));
  writeFileSync(join(tmpRoot, "providers", "nvidia.json"), JSON.stringify(provider("nvidia")));
  process.env.NVIDIA_API_KEY = "nv-test";
});

afterAll(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.MODEL_PROXY_EGRESS_PROXY_1;
  delete process.env.MODEL_PROXY_EGRESS_PROXY_2;
  setPrimaryConfigDirForTests(undefined);
  setStorageRootForTests(undefined);
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("discoverProxies", () => {
  test("accepts only proxies that pass every requested provider", async () => {
    const fetcher: UpstreamFetcher = async (input, init) => {
      const url = String(input);
      if (url === "source://proxies") {
        return new Response("http://10.0.0.1:8080\nhttp://10.0.0.2:8080\n");
      }
      const proxy = (init as RequestInit & { proxy?: string } | undefined)?.proxy;
      if (proxy === "http://10.0.0.1:8080") return new Response("{}", { status: 200 });
      if (url.includes("nvidia")) return new Response("no", { status: 403 });
      return new Response("{}", { status: 200 });
    };

    const report = await discoverProxies({
      targetCount: 2,
      providers: ["opencode", "nvidia"],
      sources: ["source://proxies"],
      persist: false,
      fetcher,
      concurrency: 1,
    });

    expect(report.accepted.map((p) => p.url)).toEqual(["http://10.0.0.1:8080"]);
    expect(report.rejectedByProvider["nvidia"]).toBe(1);
  });

  test("skips provider verification when required API key is missing", async () => {
    delete process.env.NVIDIA_API_KEY;
    const report = await discoverProxies({
      targetCount: 1,
      providers: ["nvidia"],
      candidates: ["http://candidate:8080"],
      sources: [],
      persist: false,
      fetcher: (async () => new Response("{}", { status: 200 })) as UpstreamFetcher,
    });
    expect(report.skippedProviders["nvidia"]).toBe("missing_api_key");
    process.env.NVIDIA_API_KEY = "nv-test";
  });
});

describe("upsertConfigValues", () => {
  test("updates shared proxy entries without removing unrelated stored values", () => {
    upsertConfigValues({
      CLIENT_API_KEY: "abc",
      MODEL_PROXY_EGRESS_PROXY_9: "http://old:8080",
    });
    upsertConfigValues(
      {
        MODEL_PROXY_EGRESS_PROXY_1: "http://new-a:8080",
        MODEL_PROXY_EGRESS_PROXY_2: "http://new-b:8080",
      },
      { removePrefixes: ["MODEL_PROXY_EGRESS_PROXY_"] },
    );
    const values = readConfigValues();
    expect(values["CLIENT_API_KEY"]).toBe("abc");
    expect(values["MODEL_PROXY_EGRESS_PROXY_1"]).toBe("http://new-a:8080");
    expect(values["MODEL_PROXY_EGRESS_PROXY_2"]).toBe("http://new-b:8080");
    expect(values["MODEL_PROXY_EGRESS_PROXY_9"]).toBeUndefined();

    // Secrets are sealed on disk — the raw file must not leak plaintext keys.
    const sealedText = readFileSync(join(tmpRoot, "secrets.json"), "utf8");
    expect(sealedText).not.toContain("http://new-a:8080");
    expect(sealedText).toContain("enc:v1:");
  });
});
