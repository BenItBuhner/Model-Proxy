import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PricingConfig } from "@model-proxy/contracts/schemas/pricing.ts";
import { PricingConfigSchema } from "@model-proxy/contracts/schemas/pricing.ts";
import { getStorageDir } from "./storage-paths.ts";

export interface AnalyticsPricingSettings {
  default_pricing?: PricingConfig;
}

export const BUILTIN_DEFAULT_PRICING: PricingConfig = {
  user_cost: {
    input_per_1m: 0,
    output_per_1m: 0,
  },
  typical_cost: {
    input_per_1m: 3,
    output_per_1m: 15,
  },
};

let cachedSettings: AnalyticsPricingSettings | undefined;
let cachedSettingsPath: string | undefined;
let cachedSignature: string | undefined;

/** mtime+size stamp so hand-edits (or fixes to an invalid file) are picked up
 * without a restart. Undefined when the file is missing. */
function fileSignature(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return undefined;
  }
}

export function readAnalyticsPricingSettings(): AnalyticsPricingSettings {
  const path = pricingPath();
  const signature = fileSignature(path);
  if (cachedSettings !== undefined && cachedSettingsPath === path && cachedSignature === signature) {
    return cachedSettings;
  }
  cachedSettingsPath = path;
  cachedSignature = signature;
  if (signature === undefined) {
    cachedSettings = { default_pricing: BUILTIN_DEFAULT_PRICING };
    return cachedSettings;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const defaultPricing = parsed["default_pricing"];
    if (defaultPricing !== undefined) {
      const result = PricingConfigSchema.safeParse(defaultPricing);
      if (result.success) {
        cachedSettings = { default_pricing: result.data };
        return cachedSettings;
      }
    }
    cachedSettings = { default_pricing: BUILTIN_DEFAULT_PRICING };
    return cachedSettings;
  } catch {
    cachedSettings = { default_pricing: BUILTIN_DEFAULT_PRICING };
    return cachedSettings;
  }
}

export function writeAnalyticsPricingSettings(settings: AnalyticsPricingSettings): AnalyticsPricingSettings {
  const normalized: AnalyticsPricingSettings = {};
  if (settings.default_pricing !== undefined) {
    normalized.default_pricing = PricingConfigSchema.parse(settings.default_pricing);
  }
  const path = pricingPath();
  writeFileSync(path, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  cachedSettings = normalized;
  cachedSettingsPath = path;
  cachedSignature = fileSignature(path);
  return normalized;
}

function pricingPath(): string {
  return join(getStorageDir("analytics"), "pricing.json");
}
