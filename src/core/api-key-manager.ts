/**
 * API Key Manager for handling multiple API keys per provider with fallback.
 * Parses environment variables and manages key rotation with circuit breaker pattern.
 *
 * Supports round-robin key selection and per-request cycle tracking for robust
 * fallback behavior across multiple API keys and providers.
 *
 * Enhanced with scoped failures to distinguish between provider-wide failures
 * (e.g., 401 Unauthorized) and model-specific failures (e.g., 429 Rate Limit).
 */
import { env } from "./env.ts";
import { getProviderEnvVarPatterns } from "./provider-config.ts";

const KEY_COOLDOWN_SECONDS = () => env.KEY_COOLDOWN_SECONDS;
const MAX_KEY_RETRY_CYCLES = () => env.MAX_KEY_RETRY_CYCLES;

function safeCooldownDuration(duration: unknown): number {
  if (typeof duration === "number") return duration;
  if (duration == null) return KEY_COOLDOWN_SECONDS();
  try {
    const parsed = parseInt(String(duration), 10);
    return isNaN(parsed) ? KEY_COOLDOWN_SECONDS() : parsed;
  } catch {
    return KEY_COOLDOWN_SECONDS();
  }
}

// ── Key Rotation State ────────────────────────────────────────────
interface FailInfo {
  timestamp: number;
  cooldownDuration: number;
}

interface KeyRotationState {
  lastUsedIndex: number;
  failedKeys: Map<string, FailInfo>;
  modelFailedKeys: Map<string, Map<string, FailInfo>>;
  providerFailedUntil: number;
}

function createKeyRotationState(): KeyRotationState {
  return {
    lastUsedIndex: -1,
    failedKeys: new Map(),
    modelFailedKeys: new Map(),
    providerFailedUntil: 0,
  };
}

// Global rotation state: {provider: KeyRotationState}
const _rotationState: Map<string, KeyRotationState> = new Map();

function getState(provider: string): KeyRotationState {
  let state = _rotationState.get(provider);
  if (!state) {
    state = createKeyRotationState();
    _rotationState.set(provider, state);
  }
  return state;
}

// ── Key Parsing ───────────────────────────────────────────────────
function parseProviderKeys(providerName: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();

  let patterns: string[];
  try {
    patterns = getProviderEnvVarPatterns(providerName);
  } catch {
    patterns = [];
  }

  if (patterns.length === 0) {
    const envPrefix = providerName.toUpperCase().replace(/-/g, "_");
    patterns = [`${envPrefix}_API_KEY`, `${envPrefix}_API_KEY_{INDEX}`];
  }

  const addKey = (value: string | undefined) => {
    if (value && !seen.has(value)) {
      keys.push(value);
      seen.add(value);
    }
  };

  const collectIndexed = (patternWithIndex: string): Array<[number, string]> => {
    const escaped = patternWithIndex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const modified = escaped.replace(/\\\{INDEX\\\}/g, "(\\d+)");
    const regex = new RegExp(`^${modified}$`);
    const matches: Array<[number, string]> = [];

    for (const [envVar, value] of Object.entries(process.env)) {
      const match = regex.exec(envVar);
      if (!match) continue;
      const index = parseInt(match[1], 10);
      if (isNaN(index)) continue;
      if (value) matches.push([index, value]);
    }

    matches.sort((a, b) => a[0] - b[0]);
    return matches;
  };

  for (const pattern of patterns) {
    if (pattern.includes("{INDEX}")) {
      for (const [, value] of collectIndexed(pattern)) {
        addKey(value);
      }
    } else {
      addKey(process.env[pattern]);
    }
  }

  return keys;
}

// ── Key Cycle Tracker ─────────────────────────────────────────────
export class KeyCycleTracker {
  provider: string;
  model: string | null;
  maxCycles: number;
  providerCooldown: number;
  routeCooldown: number;
  routeKey: string;

  currentCycle: number = 0;
  keysTried: Set<string> = new Set();
  private _keysAttempted: Set<string> = new Set();
  private _allKeys: string[];
  private _keyIndex: number;

  constructor(opts: {
    provider: string;
    model?: string | null;
    maxCycles?: number;
    providerCooldown?: number;
    routeCooldown?: number;
  }) {
    this.provider = opts.provider;
    this.model = opts.model ?? null;
    this.maxCycles = opts.maxCycles ?? MAX_KEY_RETRY_CYCLES();

    let pc = opts.providerCooldown ?? KEY_COOLDOWN_SECONDS();
    if (typeof pc !== "number") pc = safeCooldownDuration(pc);
    this.providerCooldown = pc;

    let rc = opts.routeCooldown ?? pc;
    if (typeof rc !== "number") rc = safeCooldownDuration(rc);
    this.routeCooldown = rc;

    this._allKeys = parseProviderKeys(opts.provider);
    this._keyIndex = getState(opts.provider).lastUsedIndex;
    this.routeKey = this.model ? `${opts.provider}/${this.model}` : opts.provider;
  }

  getNextKey(): string | null {
    if (this._allKeys.length === 0) return null;
    if (this.currentCycle >= this.maxCycles) return null;

    const state = getState(this.provider);
    const now = Date.now() / 1000;

    if (state.providerFailedUntil > now) return null;

    const numKeys = this._allKeys.length;

    for (let i = 0; i < numKeys; i++) {
      this._keyIndex = (this._keyIndex + 1) % numKeys;
      const candidate = this._allKeys[this._keyIndex];

      if (this.keysTried.has(candidate)) continue;

      if (!this._keysAttempted.has(candidate) && KEY_COOLDOWN_SECONDS() > 0) {
        // Check global failure
        const failInfo = state.failedKeys.get(candidate);
        if (failInfo && (now - failInfo.timestamp) < safeCooldownDuration(failInfo.cooldownDuration)) {
          continue;
        }

        // Check model-scoped failure
        if (this.model) {
          const modelFails = state.modelFailedKeys.get(this.routeKey);
          if (modelFails) {
            const mFailInfo = modelFails.get(candidate);
            if (mFailInfo && (now - mFailInfo.timestamp) < safeCooldownDuration(mFailInfo.cooldownDuration)) {
              continue;
            }
          }
        }
      }

      this.keysTried.add(candidate);
      this._keysAttempted.add(candidate);
      state.lastUsedIndex = this._keyIndex;
      return candidate;
    }

    // All keys tried this cycle
    if (this._shouldResetCycle()) {
      this._resetCycle();
      return this.getNextKey();
    }

    return null;
  }

  private _shouldResetCycle(): boolean {
    return this.keysTried.size >= this._allKeys.length;
  }

  private _resetCycle(): void {
    this.currentCycle++;
    this.keysTried.clear();
  }

  allKeysInCooldown(): boolean {
    if (this._allKeys.length === 0) return true;

    const state = getState(this.provider);
    const now = Date.now() / 1000;

    if (state.providerFailedUntil > now) return true;
    if (KEY_COOLDOWN_SECONDS() <= 0) return false;

    for (const key of this._allKeys) {
      const failInfo = state.failedKeys.get(key);
      if (failInfo && (now - failInfo.timestamp) < safeCooldownDuration(failInfo.cooldownDuration)) {
        continue;
      }
      if (this.model) {
        const modelFails = state.modelFailedKeys.get(this.routeKey);
        if (modelFails) {
          const mFailInfo = modelFails.get(key);
          if (mFailInfo && (now - mFailInfo.timestamp) < safeCooldownDuration(mFailInfo.cooldownDuration)) {
            continue;
          }
        }
      }
      return false; // Found at least one available key
    }
    return true;
  }

  markFailed(
    key: string,
    action: string = "model_key_failure",
    opts?: { isGlobal?: boolean; cooldownDuration?: number }
  ): void {
    let effectiveAction = action;
    if (opts?.isGlobal === true) effectiveAction = "global_key_failure";
    else if (opts?.isGlobal === false) effectiveAction = "model_key_failure";

    let duration = opts?.cooldownDuration;
    if (duration == null) {
      duration = effectiveAction === "model_key_failure" ? this.routeCooldown : this.providerCooldown;
    }

    if (effectiveAction === "provider_cooldown") {
      markProviderFailed(this.provider, duration);
    } else if (effectiveAction === "global_key_failure") {
      markKeyFailed(this.provider, key, undefined, duration);
    } else {
      // model_key_failure
      if (this.model) {
        markKeyFailed(this.provider, key, this.routeKey, duration);
      } else {
        markKeyFailed(this.provider, key, undefined, duration);
      }
    }
  }

  exhausted(): boolean {
    if (this._allKeys.length === 0) return true;
    if (this.currentCycle >= this.maxCycles) return true;
    if (this._shouldResetCycle() && this.currentCycle + 1 >= this.maxCycles) return true;
    return false;
  }

  get cyclesRemaining(): number {
    return Math.max(0, this.maxCycles - this.currentCycle);
  }

  get totalKeys(): number {
    return this._allKeys.length;
  }
}

// ── Public API ────────────────────────────────────────────────────
export function getAvailableKeys(provider: string): string[] {
  return parseProviderKeys(provider);
}

export function getApiKey(provider: string, model?: string): string | null {
  const allKeys = parseProviderKeys(provider);
  if (allKeys.length === 0) return null;

  const state = getState(provider);
  const now = Date.now() / 1000;

  if (state.providerFailedUntil > now) return null;

  const numKeys = allKeys.length;
  const routeKey = model ? `${provider}/${model}` : provider;

  for (let offset = 0; offset < numKeys; offset++) {
    const nextIndex = (state.lastUsedIndex + 1 + offset) % numKeys;
    const candidate = allKeys[nextIndex];

    const failInfo = state.failedKeys.get(candidate);
    if (failInfo && (now - failInfo.timestamp) < safeCooldownDuration(failInfo.cooldownDuration)) {
      continue;
    }

    if (model) {
      const modelFails = state.modelFailedKeys.get(routeKey);
      if (modelFails) {
        const mFailInfo = modelFails.get(candidate);
        if (mFailInfo && (now - mFailInfo.timestamp) < safeCooldownDuration(mFailInfo.cooldownDuration)) {
          continue;
        }
      }
    }

    state.lastUsedIndex = nextIndex;
    return candidate;
  }

  return null;
}

export function markKeyFailed(
  provider: string,
  key: string,
  model?: string,
  cooldownDuration?: number
): void {
  const state = getState(provider);
  const now = Date.now() / 1000;
  const duration = cooldownDuration ?? KEY_COOLDOWN_SECONDS();

  if (model) {
    let modelMap = state.modelFailedKeys.get(model);
    if (!modelMap) {
      modelMap = new Map();
      state.modelFailedKeys.set(model, modelMap);
    }
    modelMap.set(key, { timestamp: now, cooldownDuration: duration });
  } else {
    state.failedKeys.set(key, { timestamp: now, cooldownDuration: duration });
  }
}

export function markProviderFailed(provider: string, cooldownDuration: number = 180): void {
  const state = getState(provider);
  state.providerFailedUntil = Date.now() / 1000 + cooldownDuration;
}

export function resetFailedKeys(provider?: string): void {
  if (provider) {
    const state = _rotationState.get(provider);
    if (state) {
      state.failedKeys.clear();
      state.modelFailedKeys.clear();
      state.providerFailedUntil = 0;
    }
  } else {
    for (const state of _rotationState.values()) {
      state.failedKeys.clear();
      state.modelFailedKeys.clear();
      state.providerFailedUntil = 0;
    }
  }
}

export function resetRotationState(provider?: string): void {
  if (provider) {
    _rotationState.delete(provider);
  } else {
    _rotationState.clear();
  }
}
