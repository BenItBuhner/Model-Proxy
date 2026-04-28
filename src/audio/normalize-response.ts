import type { AudioResponseFormat } from "../../shared/schemas/audio-wire.ts";

export function normalizeAudioJsonResponse(
  input: unknown,
  format: AudioResponseFormat,
): Record<string, unknown> {
  const parsed = typeof input === "string" ? parseMaybeJson(input) : input;
  const text = extractText(parsed);
  if (format === "verbose_json") {
    return {
      text,
      ...optionalField("language", extractLanguage(parsed)),
      ...optionalField("duration", extractDuration(parsed)),
      ...optionalArray("segments", extractArray(parsed, "segments")),
      ...optionalArray("words", extractArray(parsed, "words")),
    };
  }
  return { text };
}

function parseMaybeJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.transcript === "string") return record.transcript;
  if (typeof record.transcription === "string") return record.transcription;
  const rivaText = extractRivaText(record.riva);
  if (rivaText.length > 0) return rivaText;
  return "";
}

function extractRivaText(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return "";
  return results
    .map((result) => {
      if (result === null || typeof result !== "object") return "";
      const alternatives = (result as { alternatives?: unknown }).alternatives;
      if (!Array.isArray(alternatives)) return "";
      const first = alternatives[0];
      if (first === null || typeof first !== "object") return "";
      const transcript = (first as { transcript?: unknown }).transcript;
      return typeof transcript === "string" ? transcript : "";
    })
    .filter((part) => part.length > 0)
    .join(" ");
}

function extractLanguage(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.language === "string") return record.language;
  const riva = record.riva;
  if (riva === null || typeof riva !== "object") return undefined;
  const results = (riva as { results?: unknown }).results;
  if (!Array.isArray(results)) return undefined;
  for (const result of results) {
    if (result === null || typeof result !== "object") continue;
    const alternatives = (result as { alternatives?: unknown }).alternatives;
    if (!Array.isArray(alternatives)) continue;
    const first = alternatives[0];
    if (first === null || typeof first !== "object") continue;
    const languageCode = (first as { languageCode?: unknown }).languageCode;
    if (Array.isArray(languageCode) && typeof languageCode[0] === "string") {
      return languageCode[0];
    }
  }
  return undefined;
}

function extractDuration(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.duration === "number") return record.duration;
  const riva = record.riva;
  if (riva === null || typeof riva !== "object") return undefined;
  const results = (riva as { results?: unknown }).results;
  if (!Array.isArray(results)) return undefined;
  const durations = results
    .map((result) =>
      result !== null && typeof result === "object"
        ? (result as { audioProcessed?: unknown }).audioProcessed
        : undefined,
    )
    .filter((duration): duration is number => typeof duration === "number");
  return durations.length > 0 ? Math.max(...durations) : undefined;
}

function extractArray(value: unknown, key: string): unknown[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const direct = (value as Record<string, unknown>)[key];
  return Array.isArray(direct) ? direct : undefined;
}

function optionalField(key: string, value: string | number | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function optionalArray(key: string, value: unknown[] | undefined): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}
