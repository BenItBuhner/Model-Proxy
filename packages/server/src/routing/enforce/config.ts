import {
  DEFAULT_GUIDANCE,
  DEFAULT_TERMINATION_FLAG,
  type EnforceToolCallConfig,
  type ResolvedEnforceConfig,
} from "@model-proxy/contracts/schemas/enforce.ts";

export interface PerRequestOverrides {
  header?: string | undefined;
  query?: string | undefined;
}

function parseBool(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return undefined;
  if (["true", "1", "yes", "on"].includes(trimmed)) return true;
  if (["false", "0", "no", "off"].includes(trimmed)) return false;
  return undefined;
}

function envDefaults(): Required<
  Pick<
    ResolvedEnforceConfig,
    "enabled"
    | "terminationFlag"
    | "maxRetries"
    | "guidance"
    | "streamChunkDelayMs"
    | "emptyResponsePolicy"
  >
> {
  const enabledRaw = process.env.ENFORCE_TOOL_CALL_MODE;
  const enabled = (enabledRaw ?? "false").toLowerCase() === "true";
  const terminationFlag =
    process.env.TOOL_CALL_TERMINATION_FLAG ?? DEFAULT_TERMINATION_FLAG;
  const maxRetriesRaw = process.env.TOOL_CALL_MAX_RETRIES;
  const maxRetriesParsed = Number.parseInt(maxRetriesRaw ?? "", 10);
  const maxRetries =
    Number.isFinite(maxRetriesParsed) && maxRetriesParsed > 0
      ? Math.min(50, maxRetriesParsed)
      : 10;
  const guidance = process.env.TOOL_CALL_INJECTION_GUIDANCE ?? DEFAULT_GUIDANCE;
  const chunkDelayRaw = process.env.STREAM_CHUNK_DELAY;
  const chunkDelayParsed = Number.parseFloat(chunkDelayRaw ?? "0");
  const streamChunkDelayMs =
    Number.isFinite(chunkDelayParsed) && chunkDelayParsed >= 0
      ? Math.min(10_000, chunkDelayParsed)
      : 0;
  const policy = process.env.EMPTY_RESPONSE_POLICY?.toLowerCase();
  const emptyResponsePolicy =
    policy === "lenient" ? "lenient" : "strict";

  return {
    enabled,
    terminationFlag,
    maxRetries,
    guidance,
    streamChunkDelayMs,
    emptyResponsePolicy,
  };
}

/**
 * Resolves the effective enforce config for a request using this precedence
 * (highest to lowest): header > query > per-model config > env defaults.
 */
export function resolveEnforceConfig(
  perModel: EnforceToolCallConfig | undefined,
  overrides: PerRequestOverrides = {},
): ResolvedEnforceConfig {
  const defaults = envDefaults();

  const headerBool = parseBool(overrides.header);
  const queryBool = parseBool(overrides.query);

  const enabled =
    headerBool ?? queryBool ?? perModel?.enabled ?? defaults.enabled;

  const terminationFlag =
    perModel?.termination_flag !== undefined && perModel.termination_flag.length > 0
      ? perModel.termination_flag
      : defaults.terminationFlag;

  const maxRetries =
    perModel?.max_retries !== undefined
      ? Math.max(1, Math.min(50, perModel.max_retries))
      : defaults.maxRetries;

  const guidance =
    perModel?.guidance !== undefined && perModel.guidance.length > 0
      ? perModel.guidance
      : defaults.guidance;

  const streamChunkDelayMs =
    perModel?.stream_chunk_delay_ms !== undefined
      ? Math.max(0, Math.min(10_000, perModel.stream_chunk_delay_ms))
      : defaults.streamChunkDelayMs;

  const emptyResponsePolicy =
    perModel?.empty_response_policy ?? defaults.emptyResponsePolicy;

  return {
    enabled,
    terminationFlag,
    maxRetries,
    guidance,
    streamChunkDelayMs,
    emptyResponsePolicy,
  };
}
