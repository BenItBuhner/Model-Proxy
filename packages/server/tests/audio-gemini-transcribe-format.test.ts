import { describe, expect, test } from "bun:test";

import {
  buildDiarizedJsonBody,
  buildSrt,
  buildVerboseJsonBody,
  buildVtt,
  parseDurationSeconds,
  parseGeminiTranscription,
  promptToCustomVocabulary,
  SUBTITLE_SEGMENTATION,
  segmentTranscript,
  toGeminiLanguageCodes,
  VERBOSE_JSON_SEGMENTATION,
} from "../src/audio/gemini-transcribe-format.ts";

/** Response shape documented for gemini-3.5-transcribe with wordTimestamp+diarization. */
function documentedResponse(): unknown {
  return {
    candidates: [
      {
        content: {
          role: "model",
          parts: [
            {
              text: "Hello world.",
              audioTranscription: {
                speakerLabel: "spk_1",
                words: [
                  { word: "Hello", startOffset: "0.100s", endOffset: "0.450s" },
                  { word: "world", startOffset: "0.500s", endOffset: "0.850s" },
                ],
              },
            },
            {
              text: "Hi there",
              audioTranscription: {
                speakerLabel: "spk_2",
                words: [
                  { word: "Hi", startOffset: "1.200s", endOffset: "1.400s" },
                  { word: "there", startOffset: "1.450s", endOffset: "1.900s" },
                ],
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ],
  };
}

describe("toGeminiLanguageCodes", () => {
  test("auto-detect when the client gives nothing usable", () => {
    expect(toGeminiLanguageCodes(undefined)).toBeUndefined();
    expect(toGeminiLanguageCodes("")).toBeUndefined();
    expect(toGeminiLanguageCodes("  ")).toBeUndefined();
    expect(toGeminiLanguageCodes("auto")).toBeUndefined();
    expect(toGeminiLanguageCodes("multi")).toBeUndefined();
  });

  test("maps bare ISO-639-1 codes onto Gemini's documented locales", () => {
    expect(toGeminiLanguageCodes("en")).toEqual(["en-US"]);
    expect(toGeminiLanguageCodes("EN")).toEqual(["en-US"]);
    expect(toGeminiLanguageCodes("zh")).toEqual(["cmn-Hans-CN"]);
    expect(toGeminiLanguageCodes("pt")).toEqual(["pt-BR"]);
    expect(toGeminiLanguageCodes("tl")).toEqual(["fil-PH"]);
  });

  test("normalises full BCP-47 tags and passes unknown codes through", () => {
    expect(toGeminiLanguageCodes("en-gb")).toEqual(["en-GB"]);
    expect(toGeminiLanguageCodes("en_US")).toEqual(["en-US"]);
    expect(toGeminiLanguageCodes("cmn-hans-cn")).toEqual(["cmn-Hans-CN"]);
    expect(toGeminiLanguageCodes("es-419")).toEqual(["es-419"]);
    expect(toGeminiLanguageCodes("xx")).toEqual(["xx"]);
  });
});

describe("promptToCustomVocabulary", () => {
  test("splits on commas, semicolons and newlines, trims and dedupes", () => {
    expect(promptToCustomVocabulary(undefined)).toEqual([]);
    expect(promptToCustomVocabulary("  ")).toEqual([]);
    expect(promptToCustomVocabulary("Gemini, Kubernetes; BigQuery\nBigQuery ,")).toEqual([
      "Gemini",
      "Kubernetes",
      "BigQuery",
    ]);
  });

  test("caps the list at 100 terms", () => {
    const prompt = Array.from({ length: 150 }, (_, i) => `term${i}`).join(",");
    expect(promptToCustomVocabulary(prompt)).toHaveLength(100);
  });
});

describe("parseDurationSeconds", () => {
  test("parses protobuf JSON durations, numbers and seconds/nanos objects", () => {
    expect(parseDurationSeconds("0.100s")).toBe(0.1);
    expect(parseDurationSeconds("12s")).toBe(12);
    expect(parseDurationSeconds("3.25")).toBe(3.25);
    expect(parseDurationSeconds(3.5)).toBe(3.5);
    expect(parseDurationSeconds({ seconds: 1, nanos: 500_000_000 })).toBe(1.5);
    expect(parseDurationSeconds("abc")).toBeUndefined();
    expect(parseDurationSeconds(undefined)).toBeUndefined();
  });
});

describe("parseGeminiTranscription", () => {
  test("flattens the documented response into text, parts and timed words", () => {
    const transcript = parseGeminiTranscription(documentedResponse());
    expect(transcript.text).toBe("Hello world. Hi there");
    expect(transcript.candidateCount).toBe(1);
    expect(transcript.finishReason).toBe("STOP");
    expect(transcript.duration).toBe(1.9);
    expect(transcript.parts.map((part) => part.speaker)).toEqual(["spk_1", "spk_2"]);
    expect(transcript.words).toEqual([
      { word: "Hello", start: 0.1, end: 0.45, speaker: "spk_1" },
      { word: "world", start: 0.5, end: 0.85, speaker: "spk_1" },
      { word: "Hi", start: 1.2, end: 1.4, speaker: "spk_2" },
      { word: "there", start: 1.45, end: 1.9, speaker: "spk_2" },
    ]);
  });

  test("keeps Gemini's own whitespace and falls back to words when a part has no text", () => {
    const transcript = parseGeminiTranscription({
      candidates: [
        {
          content: {
            parts: [
              { text: "First sentence. " },
              { text: "Second sentence." },
              { audioTranscription: { words: [{ word: "tail" }] } },
            ],
          },
        },
      ],
    });
    expect(transcript.text).toBe("First sentence. Second sentence. tail");
    expect(transcript.duration).toBeUndefined();
  });

  test("also accepts snake_case field names", () => {
    const transcript = parseGeminiTranscription({
      candidates: [
        {
          content: {
            parts: [
              {
                audio_transcription: {
                  speaker_label: "spk_3",
                  text: "yo",
                  words: [{ word: "yo", start_offset: "2s", end_offset: "2.5s" }],
                },
              },
            ],
          },
        },
      ],
    });
    expect(transcript.text).toBe("yo");
    expect(transcript.parts[0]?.speaker).toBe("spk_3");
    expect(transcript.words[0]).toEqual({ word: "yo", start: 2, end: 2.5, speaker: "spk_3" });
  });

  test("reports blocked prompts with zero candidates", () => {
    const transcript = parseGeminiTranscription({
      candidates: [],
      promptFeedback: { blockReason: "SAFETY" },
    });
    expect(transcript.candidateCount).toBe(0);
    expect(transcript.blockReason).toBe("SAFETY");
    expect(transcript.text).toBe("");
  });
});

describe("segmentTranscript", () => {
  test("never merges speaker turns and keeps formatted tokens", () => {
    const segments = segmentTranscript(
      parseGeminiTranscription(documentedResponse()),
      VERBOSE_JSON_SEGMENTATION,
    );
    expect(segments).toEqual([
      { start: 0.1, end: 0.85, text: "Hello world.", speaker: "spk_1" },
      { start: 1.2, end: 1.9, text: "Hi there", speaker: "spk_2" },
    ]);
  });

  test("splits on sentence punctuation, long silences and size caps", () => {
    const words = [
      { word: "One.", start: 0, end: 0.5 },
      { word: "Two", start: 0.6, end: 1.0 },
      { word: "three", start: 3.0, end: 3.4 },
      { word: "four", start: 3.5, end: 3.9 },
      { word: "five", start: 4.0, end: 4.4 },
    ];
    const transcript = parseGeminiTranscription({
      candidates: [
        {
          content: {
            parts: [
              {
                text: words.map((word) => word.word).join(" "),
                audioTranscription: {
                  words: words.map((word) => ({
                    word: word.word,
                    startOffset: `${word.start}s`,
                    endOffset: `${word.end}s`,
                  })),
                },
              },
            ],
          },
        },
      ],
    });
    const segments = segmentTranscript(transcript, {
      maxSeconds: 30,
      maxWords: 2,
      gapSeconds: 1.5,
    });
    expect(segments.map((segment) => segment.text)).toEqual(["One.", "Two", "three four", "five"]);
    expect(segments[1]).toMatchObject({ start: 0.6, end: 1.0 });
    expect(segments[2]).toMatchObject({ start: 3.0, end: 3.9 });
  });

  test("falls back to a single untimed segment when Gemini returned no offsets", () => {
    const transcript = parseGeminiTranscription({
      candidates: [{ content: { parts: [{ text: "plain text" }] } }],
    });
    expect(segmentTranscript(transcript, SUBTITLE_SEGMENTATION)).toEqual([
      { start: 0, end: 0, text: "plain text", speaker: undefined },
    ]);
  });
});

describe("OpenAI response builders", () => {
  test("verbose_json includes duration, segments and words only when requested", () => {
    const transcript = parseGeminiTranscription(documentedResponse());
    const withoutWords = buildVerboseJsonBody(transcript, { language: "en", granularities: [] });
    expect(withoutWords).toEqual({
      task: "transcribe",
      language: "en",
      duration: 1.9,
      text: "Hello world. Hi there",
      segments: [
        { id: 0, seek: 0, start: 0.1, end: 0.85, text: "Hello world.", speaker: "spk_1" },
        { id: 1, seek: 0, start: 1.2, end: 1.9, text: "Hi there", speaker: "spk_2" },
      ],
    });

    const withWords = buildVerboseJsonBody(transcript, {
      language: undefined,
      granularities: ["word"],
    });
    expect(withWords.language).toBeUndefined();
    expect(withWords.words).toEqual([
      { word: "Hello", start: 0.1, end: 0.45 },
      { word: "world", start: 0.5, end: 0.85 },
      { word: "Hi", start: 1.2, end: 1.4 },
      { word: "there", start: 1.45, end: 1.9 },
    ]);
  });

  test("diarized_json emits one typed segment per speaker turn", () => {
    expect(buildDiarizedJsonBody(parseGeminiTranscription(documentedResponse()))).toEqual({
      task: "transcribe",
      duration: 1.9,
      text: "Hello world. Hi there",
      segments: [
        {
          id: "seg_0",
          type: "transcript.text.segment",
          start: 0.1,
          end: 0.85,
          text: "Hello world.",
          speaker: "spk_1",
        },
        {
          id: "seg_1",
          type: "transcript.text.segment",
          start: 1.2,
          end: 1.9,
          text: "Hi there",
          speaker: "spk_2",
        },
      ],
    });
  });

  test("srt and vtt cues carry timestamps and speaker labels", () => {
    const segments = segmentTranscript(
      parseGeminiTranscription(documentedResponse()),
      SUBTITLE_SEGMENTATION,
    );
    expect(buildSrt(segments)).toBe(
      "1\n00:00:00,100 --> 00:00:00,850\n[spk_1] Hello world.\n\n" +
        "2\n00:00:01,200 --> 00:00:01,900\n[spk_2] Hi there\n",
    );
    expect(buildVtt(segments)).toBe(
      "WEBVTT\n\n" +
        "00:00:00.100 --> 00:00:00.850\n[spk_1] Hello world.\n\n" +
        "00:00:01.200 --> 00:00:01.900\n[spk_2] Hi there\n",
    );
  });

  test("subtitle timestamps roll over into minutes and hours", () => {
    const srt = buildSrt([{ start: 3661.5, end: 3662.25, text: "late", speaker: undefined }]);
    expect(srt).toBe("1\n01:01:01,500 --> 01:01:02,250\nlate\n");
  });
});
