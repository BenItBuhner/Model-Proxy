/**
 * Shared helpers for matching env var names to a provider's
 * `api_keys.env_var_patterns` specification.
 *
 * The patterns use two placeholders:
 *   - `{PROVIDER}` — upper-snake-cased provider name (e.g. "openai" -> "OPENAI").
 *   - `{INDEX}`   — a positive integer index, used for multi-key rotation.
 *
 * Example: the pattern `"{PROVIDER}_API_KEY_{INDEX}"` expanded for
 * provider "openai" becomes the regex `/^OPENAI_API_KEY_(\d+)$/`.
 */

export interface EnvMatch {
  /** The pattern that matched (with {PROVIDER} substituted but {INDEX} intact). */
  pattern: string;
  /** Matched env var name (e.g. "OPENAI_API_KEY_3"). */
  envVar: string;
  /** Index extracted from {INDEX}, or `undefined` for literal patterns. */
  index: number | undefined;
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function providerNameToEnvToken(provider: string): string {
  return provider.toUpperCase().replace(/-/g, "_");
}

/**
 * Expand a single pattern with `{PROVIDER}` replaced by the provider's
 * env token. `{INDEX}` is left as-is.
 */
export function substituteProviderToken(
  pattern: string,
  provider: string,
): string {
  return pattern.replaceAll("{PROVIDER}", providerNameToEnvToken(provider));
}

/**
 * Scan a dictionary of env vars and return every match for the given
 * patterns. Matches are de-duplicated by env var name; indexed matches
 * are sorted ascending by their numeric index.
 */
export function matchEnvKeys(
  patterns: readonly string[],
  provider: string,
  envDict: Record<string, string | undefined>,
): EnvMatch[] {
  const seen = new Set<string>();
  const results: EnvMatch[] = [];

  for (const rawPattern of patterns) {
    const pattern = substituteProviderToken(rawPattern, provider);

    if (pattern.includes("{INDEX}")) {
      const escaped = escapeRegex(pattern);
      const regex = new RegExp(
        "^" + escaped.replace(/\\\{INDEX\\\}/g, "(\\d+)") + "$",
      );
      const matches: EnvMatch[] = [];
      for (const [envVar, value] of Object.entries(envDict)) {
        if (value === undefined) continue;
        if (seen.has(envVar)) continue;
        const m = regex.exec(envVar);
        if (!m) continue;
        const idx = Number.parseInt(m[1] ?? "", 10);
        if (!Number.isFinite(idx)) continue;
        matches.push({ pattern, envVar, index: idx });
      }
      matches.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const match of matches) {
        if (seen.has(match.envVar)) continue;
        seen.add(match.envVar);
        results.push(match);
      }
    } else {
      if (envDict[pattern] === undefined) continue;
      if (seen.has(pattern)) continue;
      seen.add(pattern);
      results.push({ pattern, envVar: pattern, index: undefined });
    }
  }

  return results;
}
