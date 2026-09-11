import type { AudioTimestampGranularity } from "@model-proxy/contracts/schemas/audio-wire.ts";

/**
 * Pure request/response mapping between the OpenAI transcription surface and
 * the Gemini `generateContent` transcription API (`gemini-3.5-transcribe`).
 * Nothing in here touches the network so every branch is unit-testable.
 */

export interface GeminiTranscriptWord {
  word: string;
  start: number | undefined;
  end: number | undefined;
  speaker: string | undefined;
}

export interface GeminiTranscriptPart {
  text: string;
  speaker: string | undefined;
  words: GeminiTranscriptWord[];
}

export interface GeminiTranscript {
  text: string;
  parts: GeminiTranscriptPart[];
  words: GeminiTranscriptWord[];
  duration: number | undefined;
  finishReason: string | undefined;
  candidateCount: number;
  blockReason: string | undefined;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | undefined;
}

export interface SegmentationRules {
  maxSeconds: number;
  maxWords: number;
  gapSeconds: number;
}

/** Roughly Whisper-sized segments for `verbose_json`. */
export const VERBOSE_JSON_SEGMENTATION: SegmentationRules = {
  maxSeconds: 30,
  maxWords: 60,
  gapSeconds: 1.5,
};

/** Subtitle cues: short enough to read on screen. */
export const SUBTITLE_SEGMENTATION: SegmentationRules = {
  maxSeconds: 6,
  maxWords: 12,
  gapSeconds: 0.8,
};

/** Gemini's documented cap is 1,000 terms; it recommends ≤100 for quality. */
const MAX_CUSTOM_VOCABULARY_TERMS = 100;

/**
 * Gemini 3.5 Transcribe expects BCP-47 codes with a region (`en-US`), while
 * OpenAI clients usually send bare ISO-639-1 codes (`en`). This maps the bare
 * codes onto the locale Gemini documents for that language.
 */
const BARE_LANGUAGE_TO_GEMINI_LOCALE: Record<string, string> = {
  af: "af-ZA",
  am: "am-ET",
  ar: "ar-EG",
  as: "as-IN",
  az: "az-AZ",
  be: "be-BY",
  bg: "bg-BG",
  bn: "bn-BD",
  bs: "bs-BA",
  ca: "ca-ES",
  ceb: "ceb",
  cmn: "cmn-Hans-CN",
  cs: "cs-CZ",
  da: "da-DK",
  de: "de-DE",
  el: "el-GR",
  en: "en-US",
  es: "es-ES",
  et: "et-EE",
  fa: "fa-IR",
  fi: "fi-FI",
  fil: "fil-PH",
  fr: "fr-FR",
  gl: "gl-ES",
  gu: "gu-IN",
  ha: "ha-NG",
  he: "he-IL",
  hi: "hi-IN",
  hr: "hr-HR",
  hu: "hu-HU",
  hy: "hy-AM",
  id: "id-ID",
  is: "is-IS",
  it: "it-IT",
  iw: "he-IL",
  ja: "ja-JP",
  jv: "jv-ID",
  ka: "ka-GE",
  kea: "kea-CV",
  kk: "kk-KZ",
  km: "km-KH",
  kn: "kn-IN",
  ko: "ko-KR",
  ky: "ky-KG",
  ln: "ln-CD",
  lt: "lt-LT",
  lv: "lv-LV",
  mk: "mk-MK",
  ml: "ml-IN",
  mn: "mn-MN",
  mr: "mr-IN",
  ms: "ms-MY",
  mt: "mt-MT",
  my: "my-MM",
  nb: "nb-NO",
  ne: "ne-NP",
  nl: "nl-NL",
  no: "nb-NO",
  or: "or-IN",
  pa: "pa-IN",
  pl: "pl-PL",
  pt: "pt-BR",
  ro: "ro-RO",
  ru: "ru-RU",
  sd: "sd-Arab-IN",
  sk: "sk-SK",
  sl: "sl-SI",
  sr: "sr-RS",
  sv: "sv-SE",
  sw: "sw-KE",
  te: "te-IN",
  tg: "tg-TJ",
  th: "th-TH",
  tl: "fil-PH",
  tr: "tr-TR",
  uk: "uk-UA",
  uz: "uz-UZ",
  vi: "vi-VN",
  yue: "yue-Hant-HK",
  zh: "cmn-Hans-CN",
};

const AUTO_DETECT_LANGUAGES = new Set(["", "auto", "multi", "und"]);

/**
 * Returns `undefined` when Gemini should auto-detect the language, otherwise a
 * single-element `languageCodes` array.
 */
export function toGeminiLanguageCodes(language: string | undefined): string[] | undefined {
  if (language === undefined) return undefined;
  const trimmed = language.trim();
  if (AUTO_DETECT_LANGUAGES.has(trimmed.toLowerCase())) return undefined;
  const subtags = trimmed.split(/[-_]/).filter((part) => part.length > 0);
  if (subtags.length === 0) return undefined;
  if (subtags.length === 1) {
    const bare = subtags[0]!.toLowerCase();
    return [BARE_LANGUAGE_TO_GEMINI_LOCALE[bare] ?? bare];
  }
  return [subtags.map((subtag, index) => normalizeSubtag(subtag, index)).join("-")];
}

function normalizeSubtag(subtag: string, index: number): string {
  if (index === 0) return subtag.toLowerCase();
  if (subtag.length === 2) return subtag.toUpperCase();
  if (subtag.length === 4) {
    return subtag.charAt(0).toUpperCase() + subtag.slice(1).toLowerCase();
  }
  return subtag;
}

/**
 * OpenAI's free-text `prompt` is overwhelmingly used for vocabulary hints
 * ("names: Alice, Bob"). Gemini takes those as a list of terms.
 */
export function promptToCustomVocabulary(prompt: string | undefined): string[] {
  if (prompt === undefined) return [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of prompt.split(/[,;\n]+/)) {
    const term = raw.trim();
    if (term.length === 0 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
    if (terms.length >= MAX_CUSTOM_VOCABULARY_TERMS) break;
  }
  return terms;
}

/** Parses protobuf JSON durations (`"0.100s"`), plain numbers, or `{seconds,nanos}`. */
export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const match = /^\s*(-?\d+(?:\.\d+)?)\s*s?\s*$/.exec(value);
    if (match === null) return undefined;
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (value !== null && typeof value === "object") {
    const record = value as { seconds?: unknown; nanos?: unknown };
    const seconds = typeof record.seconds === "number" ? record.seconds : Number(record.seconds ?? 0);
    const nanos = typeof record.nanos === "number" ? record.nanos : Number(record.nanos ?? 0);
    const total = seconds + nanos / 1e9;
    return Number.isFinite(total) ? total : undefined;
  }
  return undefined;
}

/**
 * Flattens a `generateContent` response into transcript text, speaker-turn
 * parts and word timings. Only the first candidate is considered.
 */
export function parseGeminiTranscription(body: unknown): GeminiTranscript {
  const root = asRecord(body);
  const candidates = Array.isArray(root?.candidates) ? root.candidates : [];
  const candidate = asRecord(candidates[0]);
  const content = asRecord(candidate?.content);
  const rawParts = Array.isArray(content?.parts) ? content.parts : [];

  const parts: GeminiTranscriptPart[] = [];
  for (const rawPart of rawParts) {
    const part = asRecord(rawPart);
    if (part === undefined) continue;
    const transcription = asRecord(part.audioTranscription ?? part.audio_transcription);
    const speaker = firstString(transcription?.speakerLabel, transcription?.speaker_label);
    const words = parseWords(transcription?.words, speaker);
    let text = firstString(part.text, transcription?.text) ?? "";
    if (text.length === 0 && words.length > 0) {
      text = words.map((word) => word.word).join(" ");
    }
    if (text.length === 0 && words.length === 0) continue;
    parts.push({ text, speaker, words });
  }

  const words = parts.flatMap((part) => part.words);
  const ends = words.map((word) => word.end).filter((end): end is number => end !== undefined);
  const promptFeedback = asRecord(root?.promptFeedback);

  return {
    text: joinPartTexts(parts.map((part) => part.text)),
    parts,
    words,
    duration: ends.length > 0 ? Math.max(...ends) : undefined,
    finishReason: firstString(candidate?.finishReason),
    candidateCount: candidates.length,
    blockReason: firstString(promptFeedback?.blockReason),
  };
}

function parseWords(value: unknown, speaker: string | undefined): GeminiTranscriptWord[] {
  if (!Array.isArray(value)) return [];
  const out: GeminiTranscriptWord[] = [];
  for (const raw of value) {
    const record = asRecord(raw);
    const word = firstString(record?.word);
    if (record === undefined || word === undefined) continue;
    out.push({
      word,
      start: parseDurationSeconds(record.startOffset ?? record.start_offset),
      end: parseDurationSeconds(record.endOffset ?? record.end_offset),
      speaker: firstString(record.speakerLabel, record.speaker_label) ?? speaker,
    });
  }
  return out;
}

/** Gemini parts carry their own whitespace; only pad a boundary that has none. */
function joinPartTexts(texts: string[]): string {
  let out = "";
  for (const text of texts) {
    if (text.length === 0) continue;
    if (out.length > 0 && !/\s$/.test(out) && !/^\s/.test(text)) out += " ";
    out += text;
  }
  return out.trim();
}

/**
 * Groups a part's words into segments, closing a segment on terminal
 * punctuation, a long silence, or when the size caps are hit. Speaker turns
 * (parts) never merge. When the part's formatted text tokenises one-to-one
 * onto the words, the formatted tokens are used so punctuation and casing
 * survive into segment text.
 */
export function segmentTranscript(
  transcript: GeminiTranscript,
  rules: SegmentationRules,
): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const part of transcript.parts) {
    const timed = part.words.filter(
      (word): word is GeminiTranscriptWord & { start: number; end: number } =>
        word.start !== undefined && word.end !== undefined,
    );
    if (timed.length === 0) {
      segments.push({
        start: 0,
        end: transcript.duration ?? 0,
        text: part.text.trim(),
        speaker: part.speaker,
      });
      continue;
    }

    const tokens = part.text.trim().split(/\s+/).filter((token) => token.length > 0);
    const display = tokens.length === timed.length ? tokens : timed.map((word) => word.word);

    let current: string[] = [];
    let start = timed[0]!.start;
    let end = timed[0]!.end;
    const flush = () => {
      if (current.length === 0) return;
      segments.push({ start, end, text: current.join(" "), speaker: part.speaker });
      current = [];
    };

    for (let index = 0; index < timed.length; index += 1) {
      const word = timed[index]!;
      const token = display[index] ?? word.word;
      if (current.length === 0) {
        start = word.start;
        end = word.end;
      }
      current.push(token);
      end = Math.max(end, word.end);

      const next = timed[index + 1];
      const endsSentence = /[.!?。！？]["'”’)]*$/.test(token);
      const tooLong = end - start >= rules.maxSeconds || current.length >= rules.maxWords;
      const longGap = next !== undefined && next.start - end >= rules.gapSeconds;
      if (next === undefined || endsSentence || tooLong || longGap) flush();
    }
    flush();
  }
  return segments;
}

export interface VerboseJsonOptions {
  language: string | undefined;
  granularities: AudioTimestampGranularity[];
}

/** OpenAI `verbose_json` shape: text, duration, segments, and words when asked. */
export function buildVerboseJsonBody(
  transcript: GeminiTranscript,
  options: VerboseJsonOptions,
): Record<string, unknown> {
  const segments = segmentTranscript(transcript, VERBOSE_JSON_SEGMENTATION);
  const body: Record<string, unknown> = {
    task: "transcribe",
    ...(options.language !== undefined ? { language: options.language } : {}),
    ...(transcript.duration !== undefined ? { duration: round3(transcript.duration) } : {}),
    text: transcript.text,
    segments: segments.map((segment, index) => ({
      id: index,
      seek: 0,
      start: round3(segment.start),
      end: round3(segment.end),
      text: segment.text,
      ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
    })),
  };
  if (options.granularities.includes("word")) {
    body.words = transcript.words
      .filter((word) => word.start !== undefined && word.end !== undefined)
      .map((word) => ({ word: word.word, start: round3(word.start!), end: round3(word.end!) }));
  }
  return body;
}

/** OpenAI `diarized_json` shape: one segment per speaker turn. */
export function buildDiarizedJsonBody(transcript: GeminiTranscript): Record<string, unknown> {
  const segments = transcript.parts.map((part, index) => {
    const timed = part.words.filter((word) => word.start !== undefined && word.end !== undefined);
    const start = timed.length > 0 ? Math.min(...timed.map((word) => word.start!)) : 0;
    const end = timed.length > 0 ? Math.max(...timed.map((word) => word.end!)) : transcript.duration ?? 0;
    return {
      id: `seg_${index}`,
      type: "transcript.text.segment",
      start: round3(start),
      end: round3(end),
      text: part.text.trim(),
      speaker: part.speaker ?? "unknown",
    };
  });
  return {
    task: "transcribe",
    ...(transcript.duration !== undefined ? { duration: round3(transcript.duration) } : {}),
    text: transcript.text,
    segments,
  };
}

export function buildSrt(segments: TranscriptSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${formatTimestamp(segment.start, ",")} --> ${formatTimestamp(segment.end, ",")}\n${cueText(segment)}\n`,
    )
    .join("\n");
}

export function buildVtt(segments: TranscriptSegment[]): string {
  const cues = segments.map(
    (segment) =>
      `${formatTimestamp(segment.start, ".")} --> ${formatTimestamp(segment.end, ".")}\n${cueText(segment)}\n`,
  );
  return ["WEBVTT", "", ...cues].join("\n");
}

function cueText(segment: TranscriptSegment): string {
  return segment.speaker !== undefined ? `[${segment.speaker}] ${segment.text}` : segment.text;
}

function formatTimestamp(seconds: number, millisSeparator: "," | "."): string {
  const totalMillis = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return (
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(secs).padStart(2, "0")}${millisSeparator}${String(millis).padStart(3, "0")}`
  );
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
