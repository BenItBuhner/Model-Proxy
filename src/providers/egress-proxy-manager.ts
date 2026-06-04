import { createLogger } from "../observability/logger.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { matchEnvKeys, providerNameToEnvToken } from "./env-matcher.ts";
import {
  parseRetryAfterFromErrorBody,
} from "./upstream-fetch.ts";
import { ProviderAPIError } from "./errors.ts";

const log = createLogger("egress-proxy");

const DEFAULT_PROXY_COOLDOWN_SECONDS = 86400;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const MAX_PROXY_RETRY_CYCLES = envNumber("MAX_PROXY_RETRY_CYCLES", 1);

interface FailEntry {
  failedAtMs: number;
  cooldownSeconds: number;
}

interface ProxyRotationState {
  lastUsedIndex: number;
  failedProxies: Map<string, FailEntry>;
}

function newState(): ProxyRotationState {
  return { lastUsedIndex: -1, failedProxies: new Map() };
}

const rotationState = new Map<string, ProxyRotationState>();

function getState(provider: string): ProxyRotationState {
  const existing = rotationState.get(provider);
  if (existing !== undefined) return existing;
  const fresh = newState();
  rotationState.set(provider, fresh);
  return fresh;
}

function getEgressProxyPatterns(provider: string): string[] {
  try {
    const cfg = providerConfigLoader.loadProvider(provider);
    const block = cfg.egress_proxies;
    if (block === undefined || block.enabled === false) return [];
    if (block.env_var_patterns.length > 0) return block.env_var_patterns;
  } catch {
    // fall through
  }
  const upper = providerNameToEnvToken(provider);
  return [`${upper}_EGRESS_PROXY`, `${upper}_EGRESS_PROXY_{INDEX}`];
}

function getDefaultProxyCooldown(provider: string): number {
  try {
    const cfg = providerConfigLoader.loadProvider(provider);
    const block = cfg.egress_proxies;
    if (block !== undefined && typeof block.cooldown_seconds === "number") {
      return Math.max(0, Math.floor(block.cooldown_seconds));
    }
  } catch {
    // fall through
  }
  return DEFAULT_PROXY_COOLDOWN_SECONDS;
}

export interface EgressProxyEntry {
  url: string;
  envVar: string;
}

export function parseEgressProxies(provider: string): EgressProxyEntry[] {
  const patterns = getEgressProxyPatterns(provider);
  const matches = matchEnvKeys(patterns, provider, process.env);
  const seen = new Set<string>();
  const out: EgressProxyEntry[] = [];
  for (const match of matches) {
    const value = process.env[match.envVar];
    if (value === undefined || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push({ url: value, envVar: match.envVar });
  }
  return out;
}

export function providerHasEgressProxies(provider: string): boolean {
  try {
    const cfg = providerConfigLoader.loadProvider(provider);
    const block = cfg.egress_proxies;
    if (block === undefined || block.enabled === false) return false;
    return parseEgressProxies(provider).length > 0;
  } catch {
    return false;
  }
}

function isProxyInCooldown(entry: FailEntry | undefined, nowMs: number): boolean {
  if (entry === undefined) return false;
  const elapsed = nowMs - entry.failedAtMs;
  return elapsed < entry.cooldownSeconds * 1000;
}

export interface ProxyCycleTrackerOptions {
  provider: string;
  model: string | undefined;
  maxCycles?: number;
  defaultCooldownSeconds?: number;
  pinnedEnvVar?: string;
}

export class ProxyCycleTracker {
  readonly provider: string;
  readonly model: string | undefined;
  readonly maxCycles: number;
  readonly defaultCooldownSeconds: number;
  readonly routeKey: string;

  private currentCycle = 0;
  private proxiesTriedThisCycle = new Set<string>();
  private proxiesAttempted = new Set<string>();
  private readonly allProxies: EgressProxyEntry[];
  private proxyIndex: number;

  constructor(options: ProxyCycleTrackerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.maxCycles = options.maxCycles ?? MAX_PROXY_RETRY_CYCLES;
    this.defaultCooldownSeconds =
      options.defaultCooldownSeconds ?? getDefaultProxyCooldown(options.provider);
    this.routeKey =
      options.model !== undefined
        ? `${options.provider}/${options.model}`
        : options.provider;

    const all = parseEgressProxies(options.provider);
    if (options.pinnedEnvVar !== undefined) {
      this.allProxies = all.filter((p) => p.envVar === options.pinnedEnvVar);
    } else {
      this.allProxies = all;
    }
    this.proxyIndex = getState(options.provider).lastUsedIndex;
  }

  get totalProxies(): number {
    return this.allProxies.length;
  }

  getNextProxy(): EgressProxyEntry | undefined {
    if (this.allProxies.length === 0) return undefined;
    if (this.currentCycle >= this.maxCycles) return undefined;

    const state = getState(this.provider);
    const now = Date.now();
    const num = this.allProxies.length;

    for (let i = 0; i < num; i++) {
      this.proxyIndex = (this.proxyIndex + 1) % num;
      const candidate = this.allProxies[this.proxyIndex];
      if (candidate === undefined) continue;
      if (this.proxiesTriedThisCycle.has(candidate.url)) continue;

      if (!this.proxiesAttempted.has(candidate.url)) {
        if (isProxyInCooldown(state.failedProxies.get(candidate.url), now)) continue;
      }

      this.proxiesTriedThisCycle.add(candidate.url);
      this.proxiesAttempted.add(candidate.url);
      state.lastUsedIndex = this.proxyIndex;
      log.info("using egress proxy", {
        provider: this.provider,
        model: this.model,
        envVar: candidate.envVar,
      });
      return candidate;
    }

    if (this.proxiesTriedThisCycle.size >= this.allProxies.length) {
      this.currentCycle += 1;
      this.proxiesTriedThisCycle.clear();
      if (this.currentCycle < this.maxCycles) return this.getNextProxy();
    }

    return undefined;
  }

  allProxiesInCooldown(): boolean {
    if (this.allProxies.length === 0) return true;
    const state = getState(this.provider);
    const now = Date.now();
    for (const proxy of this.allProxies) {
      if (!isProxyInCooldown(state.failedProxies.get(proxy.url), now)) return false;
    }
    return true;
  }

  markFailed(
    proxyUrl: string,
    options: { cooldownSeconds?: number } = {},
  ): void {
    const duration =
      options.cooldownSeconds !== undefined
        ? Math.max(0, Math.floor(options.cooldownSeconds))
        : this.defaultCooldownSeconds;
    const state = getState(this.provider);
    state.failedProxies.set(proxyUrl, {
      failedAtMs: Date.now(),
      cooldownSeconds: duration,
    });
    log.warn("egress proxy cooldown set", {
      provider: this.provider,
      model: this.model,
      cooldownSeconds: duration,
    });
  }

  exhausted(): boolean {
    if (this.allProxies.length === 0) return true;
    if (this.currentCycle >= this.maxCycles) return true;
    if (
      this.proxiesTriedThisCycle.size >= this.allProxies.length &&
      this.currentCycle + 1 >= this.maxCycles
    ) {
      return true;
    }
    return false;
  }
}

export function resolveRetryAfterSeconds(err: unknown, provider: string): number | undefined {
  if (err instanceof ProviderAPIError) {
    if (err.retryAfterSeconds !== undefined) return err.retryAfterSeconds;
    return parseRetryAfterFromErrorBody(err.body);
  }
  return getDefaultProxyCooldown(provider);
}

export function resetProxyState(provider?: string): void {
  if (provider !== undefined) {
    rotationState.set(provider, newState());
  } else {
    rotationState.clear();
  }
}

export function getAvailableEgressProxies(provider: string): EgressProxyEntry[] {
  return parseEgressProxies(provider);
}
