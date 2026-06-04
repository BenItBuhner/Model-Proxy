import { createLogger } from "../observability/logger.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { matchEnvKeys, providerNameToEnvToken } from "./env-matcher.ts";

const log = createLogger("api-keys");

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

const KEY_COOLDOWN_SECONDS = envNumber("KEY_COOLDOWN_SECONDS", 180);
const MAX_KEY_RETRY_CYCLES = envNumber("MAX_KEY_RETRY_CYCLES", 1);

function coerceCooldownSeconds(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === "string") {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  return KEY_COOLDOWN_SECONDS;
}

interface FailEntry {
  failedAtMs: number;
  cooldownSeconds: number;
}

interface RotationState {
  lastUsedIndex: number;
  failedKeys: Map<string, FailEntry>;
  modelFailedKeys: Map<string, Map<string, FailEntry>>;
  providerFailedUntilMs: number;
}

function newState(): RotationState {
  return {
    lastUsedIndex: -1,
    failedKeys: new Map(),
    modelFailedKeys: new Map(),
    providerFailedUntilMs: 0,
  };
}

const rotationState = new Map<string, RotationState>();

function getState(provider: string): RotationState {
  const existing = rotationState.get(provider);
  if (existing !== undefined) return existing;
  const fresh = newState();
  rotationState.set(provider, fresh);
  return fresh;
}

function getProviderEnvVarPatterns(provider: string): string[] {
  try {
    const cfg = providerConfigLoader.loadProvider(provider);
    return cfg.api_keys.env_var_patterns;
  } catch {
    const upper = providerNameToEnvToken(provider);
    return [`${upper}_API_KEY`, `${upper}_API_KEY_{INDEX}`];
  }
}

export function parseProviderKeys(provider: string): string[] {
  const patterns = getProviderEnvVarPatterns(provider);
  const matches = matchEnvKeys(patterns, provider, process.env);
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of matches) {
    const value = process.env[match.envVar];
    if (value === undefined || value.length === 0) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    keys.push(value);
  }
  if (keys.length === 0) {
    try {
      const cfg = providerConfigLoader.loadProvider(provider);
      const defaultValue = cfg.api_keys.default_value;
      if (typeof defaultValue === "string" && defaultValue.length > 0) {
        keys.push(defaultValue);
      }
    } catch {
      // no provider config
    }
  }
  return keys;
}

function isKeyInCooldown(
  entry: FailEntry | undefined,
  nowMs: number,
): boolean {
  if (entry === undefined) return false;
  if (KEY_COOLDOWN_SECONDS <= 0) return false;
  const elapsed = nowMs - entry.failedAtMs;
  return elapsed < entry.cooldownSeconds * 1000;
}

export type ErrorAction =
  | "model_key_failure"
  | "global_key_failure"
  | "provider_cooldown"
  | "fallback_no_cooldown"
  | "auto_fix_tool_responses"
  | "retry"
  | "pass_through";

export interface KeyCycleTrackerOptions {
  provider: string;
  model: string | undefined;
  maxCycles?: number;
  providerCooldownSeconds?: number;
  routeCooldownSeconds?: number;
}

/**
 * Mirrors `app/core/api_key_manager.py::KeyCycleTracker`.
 * Provides round-robin key selection with scoped cooldowns and cycle limits.
 */
export class KeyCycleTracker {
  readonly provider: string;
  readonly model: string | undefined;
  readonly maxCycles: number;
  readonly providerCooldownSeconds: number;
  readonly routeCooldownSeconds: number;
  readonly routeKey: string;

  private currentCycle = 0;
  private keysTriedThisCycle = new Set<string>();
  private keysAttempted = new Set<string>();
  private readonly allKeys: string[];
  private keyIndex: number;

  constructor(options: KeyCycleTrackerOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.maxCycles = options.maxCycles ?? MAX_KEY_RETRY_CYCLES;
    this.providerCooldownSeconds = coerceCooldownSeconds(
      options.providerCooldownSeconds ?? KEY_COOLDOWN_SECONDS,
    );
    this.routeCooldownSeconds = coerceCooldownSeconds(
      options.routeCooldownSeconds ?? this.providerCooldownSeconds,
    );
    this.routeKey =
      options.model !== undefined
        ? `${options.provider}/${options.model}`
        : options.provider;
    this.allKeys = parseProviderKeys(options.provider);
    this.keyIndex = getState(options.provider).lastUsedIndex;
  }

  get totalKeys(): number {
    return this.allKeys.length;
  }

  getNextKey(): string | undefined {
    if (this.allKeys.length === 0) return undefined;
    if (this.currentCycle >= this.maxCycles) return undefined;

    const state = getState(this.provider);
    const now = Date.now();

    if (state.providerFailedUntilMs > now) {
      log.info("provider in provider-wide cooldown", { provider: this.provider });
      return undefined;
    }

    const numKeys = this.allKeys.length;
    for (let i = 0; i < numKeys; i++) {
      this.keyIndex = (this.keyIndex + 1) % numKeys;
      const candidate = this.allKeys[this.keyIndex];
      if (candidate === undefined) continue;
      if (this.keysTriedThisCycle.has(candidate)) continue;

      if (!this.keysAttempted.has(candidate) && KEY_COOLDOWN_SECONDS > 0) {
        if (isKeyInCooldown(state.failedKeys.get(candidate), now)) continue;
        if (this.model !== undefined) {
          const scoped = state.modelFailedKeys.get(this.routeKey);
          if (isKeyInCooldown(scoped?.get(candidate), now)) continue;
        }
      }

      this.keysTriedThisCycle.add(candidate);
      this.keysAttempted.add(candidate);
      state.lastUsedIndex = this.keyIndex;
      const keyHint =
        candidate.length >= 4 ? `...${candidate.slice(-4)}` : "****";
      log.info("using api key", {
        provider: this.provider,
        model: this.model,
        keyHint,
      });
      return candidate;
    }

    if (this.keysTriedThisCycle.size >= this.allKeys.length) {
      this.currentCycle += 1;
      this.keysTriedThisCycle.clear();
      log.debug("key cycle reset", {
        provider: this.provider,
        currentCycle: this.currentCycle,
        maxCycles: this.maxCycles,
      });
      if (this.currentCycle < this.maxCycles) return this.getNextKey();
    }

    return undefined;
  }

  allKeysInCooldown(): boolean {
    if (this.allKeys.length === 0) return true;
    const state = getState(this.provider);
    const now = Date.now();
    if (state.providerFailedUntilMs > now) return true;
    if (KEY_COOLDOWN_SECONDS <= 0) return false;

    for (const key of this.allKeys) {
      if (isKeyInCooldown(state.failedKeys.get(key), now)) continue;
      if (this.model !== undefined) {
        const scoped = state.modelFailedKeys.get(this.routeKey);
        if (isKeyInCooldown(scoped?.get(key), now)) continue;
      }
      return false;
    }
    return true;
  }

  markFailed(
    key: string,
    options: {
      action?: ErrorAction;
      cooldownSeconds?: number;
    } = {},
  ): void {
    const action = options.action ?? "model_key_failure";
    const keyHint = key.length >= 4 ? `...${key.slice(-4)}` : "****";
    log.warn("api key failed", {
      provider: this.provider,
      action,
      keyHint,
    });

    const duration =
      options.cooldownSeconds !== undefined
        ? coerceCooldownSeconds(options.cooldownSeconds)
        : action === "model_key_failure"
          ? this.routeCooldownSeconds
          : this.providerCooldownSeconds;

    if (action === "provider_cooldown") {
      markProviderFailed(this.provider, duration);
      return;
    }

    if (action === "global_key_failure") {
      markKeyFailed(this.provider, key, undefined, duration);
      return;
    }

    if (this.model !== undefined) {
      markKeyFailed(this.provider, key, this.routeKey, duration);
    } else {
      markKeyFailed(this.provider, key, undefined, duration);
    }
  }

  exhausted(): boolean {
    if (this.allKeys.length === 0) return true;
    if (this.currentCycle >= this.maxCycles) return true;
    if (
      this.keysTriedThisCycle.size >= this.allKeys.length &&
      this.currentCycle + 1 >= this.maxCycles
    ) {
      return true;
    }
    return false;
  }
}

export function markKeyFailed(
  provider: string,
  key: string,
  scopedRouteKey: string | undefined,
  cooldownSeconds: number,
): void {
  const state = getState(provider);
  const entry: FailEntry = {
    failedAtMs: Date.now(),
    cooldownSeconds: coerceCooldownSeconds(cooldownSeconds),
  };
  if (scopedRouteKey !== undefined) {
    let map = state.modelFailedKeys.get(scopedRouteKey);
    if (map === undefined) {
      map = new Map();
      state.modelFailedKeys.set(scopedRouteKey, map);
    }
    map.set(key, entry);
  } else {
    state.failedKeys.set(key, entry);
  }
}

export function markProviderFailed(
  provider: string,
  cooldownSeconds: number,
): void {
  const state = getState(provider);
  state.providerFailedUntilMs = Date.now() + cooldownSeconds * 1000;
  log.warn("provider-wide cooldown set", {
    provider,
    cooldownSeconds,
  });
}

export function resetKeyState(provider?: string): void {
  if (provider !== undefined) {
    rotationState.set(provider, newState());
  } else {
    rotationState.clear();
  }
}

export function getAvailableKeys(provider: string): string[] {
  return parseProviderKeys(provider);
}

export function getKeyCooldownSeconds(): number {
  return KEY_COOLDOWN_SECONDS;
}

export function getMaxKeyRetryCycles(): number {
  return MAX_KEY_RETRY_CYCLES;
}
