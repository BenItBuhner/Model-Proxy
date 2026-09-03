#!/usr/bin/env bun
/**
 * Materialize a complete Model-Proxy data dir for the `fusion-max` kernel
 * model against an OpenAI-compatible upstream (by default an existing
 * Model-Proxy deployment such as https://infer.techlitnow.com/v1).
 *
 * Writes:
 *   <data-dir>/config/providers/<provider>.json          OpenAI-compatible provider
 *   <data-dir>/config/models/{glm-5.3,glm-5.3-alt,glm-5.3-flash,kimi-k3,kimi-k3-alt,
 *                             deepseek-v4-pro-0813,deepseek-v4-pro,turbo}.json
 *   <data-dir>/config/models/fusion-max.json             from config/templates/fusion_max_template.json
 *
 * Primary logical models (glm-5.3, kimi-k3, deepseek-v4-pro-0813) are hedged
 * against their `-alt` upstream so tail latency drops without changing the
 * kernel's family semantics.
 *
 * Usage:
 *   bun run scripts/bootstrap-fusion-max.ts --data-dir /tmp/mp-fusion \
 *     --base-url https://infer.techlitnow.com/v1 --api-key-env TECHLITNOW_API_KEY
 *
 *   # On a server that already exposes those logical models, only add fusion-max:
 *   bun run scripts/bootstrap-fusion-max.ts --data-dir ~/.model-proxy --skip-upstreams
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Args {
  dataDir: string;
  baseUrl: string;
  provider: string;
  apiKeyEnv: string;
  skipUpstreams: boolean;
  hedge: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    dataDir: process.env.MODEL_PROXY_DATA_DIR ?? join(process.env.HOME ?? ".", ".model-proxy"),
    baseUrl: "https://infer.techlitnow.com/v1",
    provider: "techlitnow",
    apiKeyEnv: "TECHLITNOW_API_KEY",
    skipUpstreams: false,
    hedge: true,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--data-dir": args.dataDir = next(); break;
      case "--base-url": args.baseUrl = next().replace(/\/+$/, ""); break;
      case "--provider": args.provider = next(); break;
      case "--api-key-env": args.apiKeyEnv = next(); break;
      case "--skip-upstreams": args.skipUpstreams = true; break;
      case "--no-hedge": args.hedge = false; break;
      case "--force": args.force = true; break;
      case "-h":
      case "--help":
        console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0]);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  return args;
}

interface UpstreamModel {
  logical: string;
  upstream: string;
  alt?: string;
  contextWindow: number;
}

const UPSTREAMS: UpstreamModel[] = [
  { logical: "glm-5.3", upstream: "glm-5.3", alt: "glm-5.3-alt", contextWindow: 1_000_000 },
  { logical: "glm-5.3-alt", upstream: "glm-5.3-alt", contextWindow: 1_000_000 },
  { logical: "glm-5.3-flash", upstream: "glm-5.3-flash", contextWindow: 1_000_000 },
  { logical: "kimi-k3", upstream: "kimi-k3", alt: "kimi-k3-alt", contextWindow: 1_000_000 },
  { logical: "kimi-k3-alt", upstream: "kimi-k3-alt", contextWindow: 1_000_000 },
  { logical: "deepseek-v4-pro-0813", upstream: "deepseek-v4-pro-0813", alt: "deepseek-v4-pro", contextWindow: 1_000_000 },
  { logical: "deepseek-v4-pro", upstream: "deepseek-v4-pro", contextWindow: 1_000_000 },
  { logical: "turbo", upstream: "turbo", contextWindow: 128_000 },
];

function providerJson(args: Args): Record<string, unknown> {
  const upper = args.provider.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return {
    name: args.provider,
    display_name: `${args.provider} (OpenAI-compatible)`,
    enabled: true,
    api_keys: {
      env_var_patterns: [args.apiKeyEnv, `${upper}_API_KEY`, `${upper}_API_KEY_{INDEX}`],
      description: `Bearer keys for ${args.baseUrl}`,
    },
    endpoints: {
      base_url: args.baseUrl,
      completions: "/chat/completions",
      streaming: "/chat/completions",
      models: "/models",
      compatible_format: "openai",
    },
    authentication: { type: "bearer", header_name: "Authorization", header_format: "Bearer {api_key}" },
    request_config: {
      timeout_seconds: 600,
      max_retries: 2,
      retry_on_status: [429, 500, 502, 503, 504],
      default_parameters: {},
      required_parameters: [],
    },
    rate_limiting: { enabled: false, cooldown_seconds: 30 },
    models: {},
    error_handling: {
      "400": { action: "fallback_no_cooldown" },
      "401": { action: "global_key_failure" },
      "403": { action: "global_key_failure" },
      "429": { action: "model_key_failure" },
      "500": { action: "fallback_no_cooldown" },
      "502": { action: "model_key_failure" },
      "503": { action: "model_key_failure" },
      "504": { action: "model_key_failure" },
    },
    model_mapping: {},
  };
}

function modelJson(args: Args, model: UpstreamModel): Record<string, unknown> {
  const route = (upstream: string) => ({
    provider: args.provider,
    model: upstream,
    wire_protocol: "openai",
    context_window: model.contextWindow,
    timeout_seconds: 600,
    cooldown_seconds: 10,
  });
  const routes = [route(model.upstream)];
  const hedged = args.hedge && model.alt !== undefined;
  if (hedged) routes.push(route(model.alt!));
  return {
    logical_name: model.logical,
    timeout_seconds: 600,
    default_cooldown_seconds: 10,
    context_window: model.contextWindow,
    model_routings: routes,
    fallback_model_routings: [],
    ...(hedged
      ? {
          hedged_routing: {
            enabled: true,
            min_parallel: 2,
            max_parallel: 2,
            stagger_ms: 600,
            primary_bias: 0.7,
            include_fallback_model_routings: false,
            stream_min_content_chars: 1,
            cancel_losers: true,
          },
        }
      : {}),
  };
}

function writeJson(path: string, value: unknown, force: boolean): "written" | "kept" {
  if (existsSync(path) && !force) return "kept";
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return "written";
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(args.dataDir);
  const modelsDir = join(root, "config", "models");
  const providersDir = join(root, "config", "providers");
  mkdirSync(modelsDir, { recursive: true });
  mkdirSync(providersDir, { recursive: true });

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const template = JSON.parse(readFileSync(join(repoRoot, "config", "templates", "fusion_max_template.json"), "utf8")) as Record<string, unknown>;

  const report: string[] = [];
  if (!args.skipUpstreams) {
    const providerPath = join(providersDir, `${args.provider}.json`);
    report.push(`${writeJson(providerPath, providerJson(args), args.force)}  ${providerPath}`);
    for (const model of UPSTREAMS) {
      const path = join(modelsDir, `${model.logical}.json`);
      report.push(`${writeJson(path, modelJson(args, model), args.force)}  ${path}`);
    }
  }
  const fusionPath = join(modelsDir, "fusion-max.json");
  report.push(`${writeJson(fusionPath, template, args.force)}  ${fusionPath}`);

  console.log(report.join("\n"));
  console.log("");
  console.log(`data dir: ${root}`);
  if (!args.skipUpstreams) {
    console.log(`upstream: ${args.baseUrl} (provider "${args.provider}", key env ${args.apiKeyEnv})`);
    console.log(`export ${args.apiKeyEnv}=<key>   # required before starting the server`);
  }
  console.log(`start:    MODEL_PROXY_DATA_DIR=${root} bun run dev`);
  console.log(`use:      POST /v1/chat/completions {"model":"fusion-max", ...}  (optional: "fusion":{"effort":"max"})`);
}

main();
