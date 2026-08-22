import { z } from "zod";

export const AudioResponseFormatSchema = z.enum([
  "json",
  "text",
  "srt",
  "verbose_json",
  "vtt",
  "diarized_json",
]);

export const AudioTimestampGranularitySchema = z.enum(["word", "segment"]);

/**
 * Metadata parsed from an OpenAI-compatible multipart transcription request.
 * The binary `file` is intentionally kept outside this schema.
 */
export const AudioTranscriptionRequestSchema = z
  .object({
    model: z.string().min(1),
    language: z.string().min(1).optional(),
    prompt: z.string().optional(),
    response_format: AudioResponseFormatSchema.default("json"),
    temperature: z.number().min(0).max(1).optional(),
    timestamp_granularities: z
      .array(AudioTimestampGranularitySchema)
      .default([]),
    stream: z.boolean().default(false),
    url: z.string().min(1).optional(),
    chunking_strategy: z.unknown().optional(),
    include: z.array(z.string()).default([]),
    target_language: z.string().min(1).optional(),
    task: z.enum(["transcribe", "translate"]).optional(),
    custom_configuration: z.string().optional(),
  })
  .passthrough();

export type AudioResponseFormat = z.infer<typeof AudioResponseFormatSchema>;
export type AudioTimestampGranularity = z.infer<
  typeof AudioTimestampGranularitySchema
>;
export type AudioTranscriptionRequest = z.infer<
  typeof AudioTranscriptionRequestSchema
>;

export interface AudioTranscriptionJsonResponse {
  text: string;
  [key: string]: unknown;
}

export interface AudioVerboseJsonResponse extends AudioTranscriptionJsonResponse {
  language?: string;
  duration?: number;
  words?: Array<{ word: string; start: number; end: number }>;
  segments?: Array<Record<string, unknown>>;
}

