import type { ProviderConfig } from "@model-proxy/contracts/schemas/provider.ts";
import type {
  AudioResponseFormat,
  AudioTranscriptionRequest,
} from "@model-proxy/contracts/schemas/audio-wire.ts";
import { providerConfigLoader } from "../config/provider-loader.ts";
import { createLogger } from "../observability/logger.ts";
import { sleep, substituteEnvVars } from "../shared/utils.ts";
import {
  audioContentType,
  type AudioProviderAdapter,
  type AudioProviderCallContext,
  type AudioProviderResponse,
  AudioProviderCapabilityError,
  AudioProviderUpstreamError,
  mergeSignals,
  requireAudioCapabilities,
} from "./base.ts";
import {
  buildDiarizedJsonBody,
  buildSrt,
  buildVerboseJsonBody,
  buildVtt,
  type GeminiTranscript,
  parseGeminiTranscription,
  promptToCustomVocabulary,
  SUBTITLE_SEGMENTATION,
  segmentTranscript,
  toGeminiLanguageCodes,
} from "./gemini-transcribe-format.ts";

const log = createLogger("audio.gemini-transcribe");

const DEFAULT_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
/**
 * generateContent accepts requests up to ~100 MB. Base64 inflates audio by a
 * third, so anything above this raw size goes through the Files API instead.
 */
const DEFAULT_INLINE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_FILE_POLL_INTERVAL_MS = 1000;
const FILE_CLEANUP_TIMEOUT_MS = 5000;

/** Output formats that need word timings from Gemini to be rendered. */
const TIMED_FORMATS: ReadonlySet<AudioResponseFormat> = new Set([
  "verbose_json",
  "srt",
  "vtt",
  "diarized_json",
]);

const MIME_ALIASES: Record<string, string> = {
  "audio/x-wav": "audio/wav",
  "audio/wave": "audio/wav",
  "audio/vnd.wave": "audio/wav",
  "audio/x-pn-wav": "audio/wav",
  "audio/mpeg3": "audio/mp3",
  "audio/x-mpeg-3": "audio/mp3",
  "audio/x-m4a": "audio/m4a",
  "audio/mp4": "audio/m4a",
  "audio/x-flac": "audio/flac",
  "audio/x-aiff": "audio/aiff",
  "audio/x-ogg": "audio/ogg",
  "application/ogg": "audio/ogg",
  "video/webm": "audio/webm",
  "audio/x-aac": "audio/aac",
  "audio/aacp": "audio/aac",
  "audio/basic": "audio/mulaw",
  "audio/x-mulaw": "audio/mulaw",
  "audio/x-alaw": "audio/alaw",
};

const EXTENSION_TO_MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mp3",
  mpeg: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/m4a",
  mp4: "audio/m4a",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  webm: "audio/webm",
  weba: "audio/webm",
  aiff: "audio/aiff",
  aif: "audio/aiff",
};

export interface GeminiTranscribeProviderOptions {
  inlineMaxBytes?: number;
  filePollIntervalMs?: number;
}

interface TranscriptionPlan {
  format: AudioResponseFormat;
  /** `generationConfig.audioTranscriptionConfig` payload. */
  config: Record<string, unknown>;
  /** Language as the client sent it, echoed back in verbose_json. */
  language: string | undefined;
  granularities: AudioTranscriptionRequest["timestamp_granularities"];
}

interface GeminiSession {
  provider: string;
  apiBase: string;
  apiKey: string;
  signal: AbortSignal | undefined;
}

interface UploadedFile {
  name: string;
  uri: string;
  mimeType: string;
}

/**
 * Speech-to-text through Gemini's native `generateContent` transcription API.
 * Gemini's OpenAI-compatible facade has no `/audio/transcriptions` endpoint,
 * so this adapter speaks the native wire format and renders the result back
 * into the OpenAI response shapes (`json`, `text`, `verbose_json`, `srt`,
 * `vtt`, `diarized_json`).
 */
export class GeminiTranscribeAudioProvider implements AudioProviderAdapter {
  readonly format = "gemini_transcribe" as const;
  private readonly inlineMaxBytes: number;
  private readonly filePollIntervalMs: number;

  constructor(options: GeminiTranscribeProviderOptions = {}) {
    this.inlineMaxBytes = options.inlineMaxBytes ?? DEFAULT_INLINE_MAX_BYTES;
    this.filePollIntervalMs = options.filePollIntervalMs ?? DEFAULT_FILE_POLL_INTERVAL_MS;
  }

  async transcribe(ctx: AudioProviderCallContext): Promise<AudioProviderResponse> {
    requireAudioCapabilities(ctx.route.capabilities, ctx.request);
    const request = ctx.request;
    if (request.stream) {
      throw new AudioProviderCapabilityError(
        "Gemini Transcribe does not support SSE streaming transcription.",
      );
    }
    if (request.task === "translate" || request.target_language !== undefined) {
      throw new AudioProviderCapabilityError(
        "Gemini Transcribe does not support translation requests.",
      );
    }
    const file = ctx.file ?? ctx.formData.get("file");
    if (!(file instanceof Blob)) {
      throw new AudioProviderCapabilityError(
        "Gemini Transcribe requires an uploaded audio file; URL input is not supported.",
      );
    }
    const mimeType = resolveMimeType(file);
    if (mimeType === undefined) {
      throw new AudioProviderCapabilityError(
        "Gemini Transcribe could not determine the audio MIME type from the upload.",
      );
    }

    const plan = planTranscription(request, ctx.route.languageDefault);
    const providerConfig = providerConfigLoader.loadProvider(ctx.route.provider);
    const timeoutMs = Math.max(1, ctx.route.timeoutSeconds) * 1000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const session: GeminiSession = {
      provider: ctx.route.provider,
      apiBase: resolveApiBase(ctx.route.baseUrl, providerConfig),
      apiKey: ctx.route.apiKey,
      signal: mergeSignals(ctx.signal, controller.signal),
    };

    let uploaded: UploadedFile | undefined;
    try {
      let audioPart: Record<string, unknown>;
      if (file.size <= this.inlineMaxBytes) {
        audioPart = {
          inlineData: {
            mimeType,
            data: Buffer.from(await file.arrayBuffer()).toString("base64"),
          },
        };
      } else {
        uploaded = await uploadFile(session, file, mimeType, displayName(file), this.filePollIntervalMs);
        audioPart = { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } };
      }

      const model = ctx.route.model.replace(/^models\//, "");
      const raw = await postJson(
        session,
        `${session.apiBase}/models/${encodeURIComponent(model)}:generateContent`,
        {
          contents: [{ parts: [audioPart] }],
          generationConfig: { audioTranscriptionConfig: plan.config },
        },
      );
      const transcript = parseGeminiTranscription(raw);
      assertUsableTranscript(session.provider, transcript, raw);
      return renderResponse(transcript, plan);
    } catch (err) {
      throw translateAbort(err, ctx, timeoutMs);
    } finally {
      clearTimeout(timer);
      if (uploaded !== undefined) await deleteUploadedFile(session, uploaded);
    }
  }
}

function planTranscription(
  request: AudioTranscriptionRequest,
  languageDefault: string | undefined,
): TranscriptionPlan {
  const format = request.response_format ?? "json";
  const wantsWords = TIMED_FORMATS.has(format);
  const wantsDiarization = format === "diarized_json";
  const language = request.language ?? languageDefault;
  const languageCodes = toGeminiLanguageCodes(language);
  let vocabulary = promptToCustomVocabulary(request.prompt);
  if (vocabulary.length > 0 && (wantsWords || wantsDiarization)) {
    // Gemini rejects customVocabulary combined with timestamps or diarization;
    // the structural request wins over the soft vocabulary hint.
    log.debug("dropping prompt vocabulary: incompatible with timestamps/diarization", {
      format,
      terms: vocabulary.length,
    });
    vocabulary = [];
  }
  return {
    format,
    language,
    granularities: request.timestamp_granularities,
    config: {
      ...(languageCodes !== undefined ? { languageCodes } : {}),
      ...(vocabulary.length > 0 ? { customVocabulary: vocabulary } : {}),
      ...(wantsWords ? { wordTimestamp: true } : {}),
      ...(wantsDiarization ? { diarization: true } : {}),
    },
  };
}

function renderResponse(transcript: GeminiTranscript, plan: TranscriptionPlan): AudioProviderResponse {
  const headers = new Headers({ "content-type": audioContentType(plan.format) });
  const done = (body: string): AudioProviderResponse => ({
    body,
    status: 200,
    headers,
    streaming: false,
  });
  switch (plan.format) {
    case "text":
      return done(transcript.text);
    case "verbose_json":
      return done(
        JSON.stringify(
          buildVerboseJsonBody(transcript, {
            language: plan.language,
            granularities: plan.granularities,
          }),
        ),
      );
    case "diarized_json":
      return done(JSON.stringify(buildDiarizedJsonBody(transcript)));
    case "srt":
      return done(buildSrt(segmentTranscript(transcript, SUBTITLE_SEGMENTATION)));
    case "vtt":
      return done(buildVtt(segmentTranscript(transcript, SUBTITLE_SEGMENTATION)));
    default:
      return done(JSON.stringify({ text: transcript.text }));
  }
}

function assertUsableTranscript(provider: string, transcript: GeminiTranscript, raw: unknown): void {
  if (transcript.candidateCount === 0) {
    const reason = transcript.blockReason !== undefined ? ` (blocked: ${transcript.blockReason})` : "";
    throw new AudioProviderUpstreamError(
      `${provider} gemini transcription returned no candidates${reason}`,
      502,
      true,
      safeStringify(raw),
    );
  }
  if (
    transcript.text.length === 0 &&
    transcript.finishReason !== undefined &&
    transcript.finishReason !== "STOP"
  ) {
    throw new AudioProviderUpstreamError(
      `${provider} gemini transcription ended with finishReason=${transcript.finishReason} and no text`,
      502,
      true,
      safeStringify(raw),
    );
  }
}

async function postJson(session: GeminiSession, url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": session.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: session.signal,
  });
  const text = await response.text();
  if (response.status >= 400) throw upstreamError(session.provider, response.status, text);
  return parseJsonBody(session.provider, text);
}

/**
 * Files API resumable upload: `start` returns a one-shot upload URL, the bytes
 * are pushed with `upload, finalize`, then the file is polled until ACTIVE.
 */
async function uploadFile(
  session: GeminiSession,
  file: Blob,
  mimeType: string,
  name: string,
  pollIntervalMs: number,
): Promise<UploadedFile> {
  const start = await fetch(`${uploadBase(session.apiBase)}/files`, {
    method: "POST",
    headers: {
      "x-goog-api-key": session.apiKey,
      "content-type": "application/json",
      "x-goog-upload-protocol": "resumable",
      "x-goog-upload-command": "start",
      "x-goog-upload-header-content-length": String(file.size),
      "x-goog-upload-header-content-type": mimeType,
    },
    body: JSON.stringify({ file: { display_name: name } }),
    signal: session.signal,
  });
  const startText = await start.text();
  if (start.status >= 400) throw upstreamError(session.provider, start.status, startText);
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (uploadUrl === null || uploadUrl.length === 0) {
    throw new AudioProviderUpstreamError(
      `${session.provider} gemini files api did not return an upload url`,
      502,
      true,
      startText,
    );
  }

  const finalize = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "x-goog-api-key": session.apiKey,
      "content-type": mimeType,
      "x-goog-upload-offset": "0",
      "x-goog-upload-command": "upload, finalize",
    },
    body: file,
    signal: session.signal,
  });
  const finalizeText = await finalize.text();
  if (finalize.status >= 400) throw upstreamError(session.provider, finalize.status, finalizeText);
  let resource = readFileResource(session.provider, parseJsonBody(session.provider, finalizeText), finalizeText);

  while (resource.state === "PROCESSING") {
    await sleep(pollIntervalMs, session.signal);
    const poll = await fetch(`${session.apiBase}/${resource.name}`, {
      headers: { "x-goog-api-key": session.apiKey },
      signal: session.signal,
    });
    const pollText = await poll.text();
    if (poll.status >= 400) throw upstreamError(session.provider, poll.status, pollText);
    resource = readFileResource(session.provider, parseJsonBody(session.provider, pollText), pollText);
  }
  if (resource.state === "FAILED") {
    throw new AudioProviderUpstreamError(
      `${session.provider} gemini files api failed to process the uploaded audio`,
      502,
      true,
      finalizeText,
    );
  }
  return { name: resource.name, uri: resource.uri, mimeType: resource.mimeType ?? mimeType };
}

function readFileResource(
  provider: string,
  parsed: unknown,
  rawText: string,
): { name: string; uri: string; state: string | undefined; mimeType: string | undefined } {
  const root = asRecord(parsed);
  const file = asRecord(root?.file) ?? root;
  const name = typeof file?.name === "string" ? file.name : undefined;
  const uri = typeof file?.uri === "string" ? file.uri : undefined;
  if (name === undefined || uri === undefined) {
    throw new AudioProviderUpstreamError(
      `${provider} gemini files api returned an incomplete file resource`,
      502,
      true,
      rawText,
    );
  }
  return {
    name,
    uri,
    state: typeof file?.state === "string" ? file.state : undefined,
    mimeType: typeof file?.mimeType === "string" ? file.mimeType : undefined,
  };
}

/** Uploaded files expire after 48h anyway; deletion is best-effort hygiene. */
async function deleteUploadedFile(session: GeminiSession, file: UploadedFile): Promise<void> {
  try {
    await fetch(`${session.apiBase}/${file.name}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": session.apiKey },
      signal: AbortSignal.timeout(FILE_CLEANUP_TIMEOUT_MS),
    });
  } catch (err) {
    log.debug("failed to delete uploaded gemini file", { name: file.name, err: String(err) });
  }
}

/**
 * Route `base_url` wins, then the provider's proxy override, then the
 * provider base URL. The stock gemini provider points at the OpenAI-compat
 * facade (`.../v1beta/openai/`); the native API is its parent path.
 */
export function resolveApiBase(routeBaseUrl: string | undefined, providerConfig: ProviderConfig): string {
  let base = routeBaseUrl ?? providerConfig.endpoints.base_url;
  if (providerConfig.proxy_support?.enabled === true) {
    const override = providerConfig.proxy_support.base_url_override;
    if (typeof override === "string" && override.length > 0) base = override;
  }
  base = substituteEnvVars(base).replace(/\/+$/, "").replace(/\/openai$/i, "");
  return base.length > 0 ? base : DEFAULT_API_BASE;
}

/** `https://host/v1beta` → `https://host/upload/v1beta`. */
export function uploadBase(apiBase: string): string {
  const url = new URL(apiBase);
  url.pathname = `/upload${url.pathname.replace(/\/+$/, "")}`;
  return url.toString().replace(/\/+$/, "");
}

export function resolveMimeType(file: Blob): string | undefined {
  const declared = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const aliased = MIME_ALIASES[declared];
  if (aliased !== undefined) return aliased;
  if (declared.startsWith("audio/")) return declared;
  const name = displayName(file).toLowerCase();
  const extension = /\.([a-z0-9]+)$/.exec(name)?.[1];
  return extension !== undefined ? EXTENSION_TO_MIME[extension] : undefined;
}

function displayName(file: Blob): string {
  const name = (file as { name?: unknown }).name;
  return typeof name === "string" && name.length > 0 ? name : "audio";
}

function upstreamError(provider: string, status: number, bodyText: string): AudioProviderUpstreamError {
  const detail = extractGeminiErrorMessage(bodyText) ?? bodyText.slice(0, 500);
  return new AudioProviderUpstreamError(
    `${provider} gemini transcription error ${status}: ${detail}`,
    status,
    status === 429 || status >= 500,
    bodyText,
  );
}

function extractGeminiErrorMessage(bodyText: string): string | undefined {
  try {
    const parsed = asRecord(JSON.parse(bodyText));
    const error = asRecord(parsed?.error);
    const message = error?.message;
    const status = error?.status;
    if (typeof message === "string") {
      return typeof status === "string" ? `${message} [${status}]` : message;
    }
  } catch {
    // not JSON
  }
  return undefined;
}

function parseJsonBody(provider: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new AudioProviderUpstreamError(
      `${provider} gemini transcription returned invalid JSON`,
      502,
      true,
      text,
    );
  }
}

/**
 * A timeout we imposed becomes a retryable 504 so the router can fall back;
 * a client disconnect is passed through untouched so the router stops.
 */
function translateAbort(err: unknown, ctx: AudioProviderCallContext, timeoutMs: number): unknown {
  if (!isAbortError(err)) return err;
  if (ctx.signal?.aborted === true) return err;
  return new AudioProviderUpstreamError(
    `${ctx.route.provider} gemini transcription timed out after ${Math.round(timeoutMs / 1000)}s`,
    504,
    true,
    "",
  );
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 2000);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
