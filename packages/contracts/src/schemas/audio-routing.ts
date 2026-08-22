import { z } from "zod";

const EnvSubstitutedUrlSchema = z.string().min(1).refine(
  (value) => value.includes("${") || z.string().url().safeParse(value).success,
  "Expected a valid URL or an environment-substituted URL like ${PROVIDER_BASE_URL}.",
);

export const AudioProviderFormatSchema = z.enum([
  "openai_audio",
  "nvidia_nim_http",
  "nvidia_riva_grpc",
]);

export const AudioCapabilitiesSchema = z
  .object({
    streaming: z.boolean().default(false),
    text: z.boolean().default(true),
    verbose_json: z.boolean().default(true),
    srt: z.boolean().default(false),
    vtt: z.boolean().default(false),
    timestamps: z.boolean().default(false),
    url_input: z.boolean().default(false),
  })
  .partial()
  .default({});

export const AudioRouteConfigSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    format: AudioProviderFormatSchema.default("openai_audio"),
    base_url: EnvSubstitutedUrlSchema.optional(),
    api_key_env: z.array(z.string().min(1)).optional(),
    function_id: z.string().min(1).optional(),
    timeout_seconds: z.number().int().positive().optional(),
    cooldown_seconds: z.number().int().nonnegative().optional(),
    language_default: z.string().min(1).optional(),
    response_format_default: z
      .enum(["json", "text", "srt", "verbose_json", "vtt", "diarized_json"])
      .optional(),
    capabilities: AudioCapabilitiesSchema.optional(),
  })
  .strict();

export const AudioModelRoutingConfigSchema = z
  .object({
    logical_name: z.string().min(1),
    timeout_seconds: z.number().int().positive().default(60),
    default_cooldown_seconds: z.number().int().nonnegative().default(180),
    audio_routings: z.array(AudioRouteConfigSchema).min(1),
    fallback_audio_routings: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type AudioProviderFormat = z.infer<typeof AudioProviderFormatSchema>;
export type AudioCapabilities = z.infer<typeof AudioCapabilitiesSchema>;
export type AudioRouteConfig = z.infer<typeof AudioRouteConfigSchema>;
export type AudioModelRoutingConfig = z.infer<
  typeof AudioModelRoutingConfigSchema
>;

export interface ResolvedAudioRoute {
  sourceLogicalModel: string;
  provider: string;
  model: string;
  format: AudioProviderFormat;
  baseUrl: string | undefined;
  apiKey: string;
  apiKeyEnvVar: string;
  functionId?: string;
  timeoutSeconds: number;
  cooldownSeconds: number;
  languageDefault: string | undefined;
  responseFormatDefault: string | undefined;
  capabilities: AudioCapabilities;
}

export class AudioRoutingError extends Error {
  readonly logicalModel: string;
  readonly errors: Array<Record<string, unknown>>;

  constructor(
    logicalModel: string,
    errors: Array<Record<string, unknown>>,
    message: string,
  ) {
    super(message);
    this.name = "AudioRoutingError";
    this.logicalModel = logicalModel;
    this.errors = errors;
  }
}

