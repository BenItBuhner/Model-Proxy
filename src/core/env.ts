/**
 * Environment configuration loading.
 * Bun natively loads .env files, so we just read from process.env.
 */

function envStr(key: string, fallback?: string): string | undefined {
  return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined || val === "") return fallback;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? fallback : parsed;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key]?.toLowerCase();
  if (val === undefined) return fallback;
  return ["true", "1", "yes"].includes(val);
}

export const env = {
  get CLIENT_API_KEY() { return envStr("CLIENT_API_KEY"); },
  get KEY_COOLDOWN_SECONDS() { return envInt("KEY_COOLDOWN_SECONDS", 180); },
  get MAX_KEY_RETRY_CYCLES() { return envInt("MAX_KEY_RETRY_CYCLES", 1); },
  get LOG_LEVEL() { return envStr("LOG_LEVEL", "INFO")!; },
  get VERBOSE_HTTP_ERRORS() { return envBool("VERBOSE_HTTP_ERRORS", false); },
  get CORS_ORIGINS() { return envStr("CORS_ORIGINS", "*")!; },
  get PORT() { return envInt("PORT", 9876); },
  get HOST() { return envStr("HOST", "127.0.0.1")!; },
  get GEMINI_INCLUDE_THOUGHT_SIGNATURE() { return envBool("GEMINI_INCLUDE_THOUGHT_SIGNATURE", false); },
  get FAIL_ON_STARTUP_VALIDATION() { return envBool("FAIL_ON_STARTUP_VALIDATION", false); },
  get REQUIRE_CLIENT_API_KEY() { return envBool("REQUIRE_CLIENT_API_KEY", false); },
};
