"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { EventTimeline } from "@/components/test/event-timeline";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Panel } from "@/components/ui/panel";
import { Badge, StatusDot } from "@/components/ui/badge";
import {
  listAudioModels,
  transcribeAudio,
  type AudioTranscriptionResult,
} from "@/lib/audio-api";
import { generateRequestId, openEventStream } from "@/lib/test-dispatch";
import type { RequestEvent } from "@model-proxy/contracts/api/events.ts";

const FORMATS = ["json", "text", "verbose_json", "srt", "vtt"] as const;
const LEVEL_BAR_COUNT = 28;
const IDLE_LEVELS: number[] = Array.from({ length: LEVEL_BAR_COUNT }, () => 0);

export function AudioBody({
  embedded = false,
}: {
  embedded?: boolean;
}): React.ReactElement {
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("complete-stt");
  const [responseFormat, setResponseFormat] = useState("json");
  const [language, setLanguage] = useState("");
  const [prompt, setPrompt] = useState("");
  const [temperature, setTemperature] = useState("");
  const [stream, setStream] = useState(false);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [recordedUrl, setRecordedUrl] = useState<string | undefined>(undefined);
  const [recordingState, setRecordingState] = useState<
    "idle" | "requesting" | "recording" | "ready" | "error"
  >("idle");
  const [recordingStatus, setRecordingStatus] = useState("microphone idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("idle");
  const [events, setEvents] = useState<RequestEvent[]>([]);
  const [streamText, setStreamText] = useState("");
  const [result, setResult] = useState<AudioTranscriptionResult | undefined>();
  const abortRef = useRef<AbortController | undefined>(undefined);
  const mediaStreamRef = useRef<MediaStream | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
  const audioProcessorRef = useRef<ScriptProcessorNode | undefined>(undefined);
  const pcmChunksRef = useRef<Float32Array[]>([]);
  const recordingSampleRateRef = useRef(16000);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );
  const levelsRef = useRef<number[]>(IDLE_LEVELS.slice());
  const levelFrameRef = useRef<number | undefined>(undefined);
  const [levels, setLevels] = useState<number[]>(IDLE_LEVELS);

  const stopRecordingTimer = useCallback(() => {
    if (recordingTimerRef.current !== undefined) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = undefined;
    }
  }, []);

  const cleanupRecorder = useCallback(() => {
    stopRecordingTimer();
    if (levelFrameRef.current !== undefined) {
      cancelAnimationFrame(levelFrameRef.current);
      levelFrameRef.current = undefined;
    }
    const processor = audioProcessorRef.current;
    if (processor !== undefined) {
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    audioProcessorRef.current = undefined;
    audioSourceRef.current?.disconnect();
    audioSourceRef.current = undefined;
    void audioContextRef.current?.close();
    audioContextRef.current = undefined;
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = undefined;
    pcmChunksRef.current = [];
    levelsRef.current = IDLE_LEVELS.slice();
    setLevels(IDLE_LEVELS);
  }, [stopRecordingTimer]);

  useEffect(() => {
    let cancelled = false;
    listAudioModels()
      .then((res) => {
        if (cancelled) return;
        const ids = res.data.map((item) => item.id);
        setModels(ids);
        setModel((current) =>
          ids.length > 0 && !ids.includes(current) ? ids[0] ?? current : current,
        );
      })
      .catch((err) => setStatus(`model load failed: ${(err as Error).message}`));
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      cleanupRecorder();
    };
  }, [cleanupRecorder]);

  const run = useCallback(async () => {
    if (file === undefined || model.trim().length === 0) return;
    setBusy(true);
    setStatus("opening events…");
    setEvents([]);
    setResult(undefined);
    setStreamText("");
    const abort = new AbortController();
    abortRef.current = abort;
    const requestId = generateRequestId();
    const handle = openEventStream(requestId, {
      onEvent: (event) => setEvents((prev) => [...prev, event]),
      onDone: () => setStatus((s) => (s.startsWith("error:") ? s : "done")),
      onError: () => setStatus("events unavailable"),
    });

    try {
      setStatus("transcribing…");
      const result = await transcribeAudio({
        requestId,
        model,
        file,
        responseFormat,
        language,
        prompt,
        temperature,
        stream,
        signal: abort.signal,
        onChunk: (chunk) => setStreamText((prev) => prev + chunk),
      });
      setResult(result);
      setStatus(result.status >= 400 ? `error: HTTP ${result.status}` : "done");
      setTimeout(() => handle.close(), 1200);
    } catch (err) {
      if ((err as Error).name === "AbortError") setStatus("aborted");
      else setStatus(`error: ${(err as Error).message}`);
      handle.close();
    } finally {
      setBusy(false);
    }
  }, [file, language, model, prompt, responseFormat, stream, temperature]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const startRecording = useCallback(async () => {
    if (typeof navigator === "undefined" || navigator.mediaDevices === undefined) {
      setRecordingState("error");
      setRecordingStatus("microphone capture is unavailable in this browser");
      return;
    }

    setRecordingState("requesting");
    setRecordingStatus("requesting microphone permission…");
    setRecordingSeconds(0);
    setResult(undefined);
    setStreamText("");

    try {
      cleanupRecorder();
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = mediaStream;
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(mediaStream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      pcmChunksRef.current = [];
      recordingSampleRateRef.current = audioContext.sampleRate;
      levelsRef.current = IDLE_LEVELS.slice();
      setLevels(IDLE_LEVELS);
      processor.onaudioprocess = (event) => {
        const input = event.inputBuffer.getChannelData(0);
        pcmChunksRef.current.push(new Float32Array(input));
        event.outputBuffer.getChannelData(0).fill(0);
        let sumSquares = 0;
        for (let i = 0; i < input.length; i += 1) {
          sumSquares += input[i] * input[i];
        }
        const rms = Math.sqrt(sumSquares / input.length);
        const history = levelsRef.current;
        const next = new Array<number>(history.length);
        for (let i = 0; i < history.length - 1; i += 1) {
          next[i] = history[i + 1] ?? 0;
        }
        next[history.length - 1] = rms;
        levelsRef.current = next;
      };
      source.connect(processor);
      processor.connect(audioContext.destination);
      audioContextRef.current = audioContext;
      audioSourceRef.current = source;
      audioProcessorRef.current = processor;
      setRecordingState("recording");
      setRecordingStatus("recording… speak now");
      recordingTimerRef.current = setInterval(
        () => setRecordingSeconds((seconds) => seconds + 1),
        1000,
      );
      const tick = () => {
        setLevels(levelsRef.current.slice());
        levelFrameRef.current = requestAnimationFrame(tick);
      };
      levelFrameRef.current = requestAnimationFrame(tick);
    } catch (err) {
      cleanupRecorder();
      setRecordingState("error");
      setRecordingStatus(
        err instanceof Error ? err.message : "microphone permission failed",
      );
    }
  }, [cleanupRecorder, stopRecordingTimer]);

  const stopRecording = useCallback(() => {
    if (recordingState === "recording") {
      setRecordingStatus("processing recording…");
      stopRecordingTimer();
      const chunks = pcmChunksRef.current.slice();
      const sampleRate = recordingSampleRateRef.current;
      const blob = encodeWav(chunks, sampleRate);
      cleanupRecorder();
      if (chunks.length === 0 || blob.size <= 44) {
        setRecordingState("error");
        setRecordingStatus("no audio was captured");
        return;
      }
      const recordedFile = new File(
        [blob],
        `voice-recording-${new Date().toISOString().replaceAll(":", "-")}.wav`,
        { type: "audio/wav" },
      );
      setFile(recordedFile);
      setRecordedUrl((previous) => {
        if (previous !== undefined) URL.revokeObjectURL(previous);
        return URL.createObjectURL(blob);
      });
      setRecordingState("ready");
      setRecordingStatus("recording ready as mono 16-bit WAV");
      return;
    }
    cleanupRecorder();
  }, [cleanupRecorder, recordingState, stopRecordingTimer]);

  const clearRecording = useCallback(() => {
    cleanupRecorder();
    setFile(undefined);
    setRecordedUrl((previous) => {
      if (previous !== undefined) URL.revokeObjectURL(previous);
      return undefined;
    });
    setRecordingState("idle");
    setRecordingStatus("microphone idle");
    setRecordingSeconds(0);
  }, [cleanupRecorder]);

  return (
    <div className="space-y-6">
      {!embedded ? (
        <PageHeader
          eyebrow="audio"
          title="Audio transcription"
          description="Upload speech, route it through OpenAI-compatible or NVIDIA NIM audio providers, and inspect the exact proxy events."
        />
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(280px,0.75fr)_minmax(0,1.25fr)]">
        <Panel
          title="transcription request"
          subtitle="OpenAI-compatible multipart input"
          className="overflow-hidden"
        >
          <div className="space-y-5">
            <div className="overflow-hidden bg-ink-900 shadow-edge">
              <div className="flex items-center justify-between gap-4 border-b border-ink-500 px-4 py-3">
                <div>
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-bone-500">
                    <StatusDot
                      tone={
                        recordingState === "recording"
                          ? "danger"
                          : recordingState === "ready"
                            ? "phosphor"
                            : recordingState === "error"
                              ? "warning"
                              : "muted"
                      }
                    />
                    Voice recorder
                  </div>
                  <p className="mt-1 text-sm text-bone-500">
                    Record directly from your microphone, preview it, then send it
                    through the selected transcription route.
                  </p>
                </div>
                <Badge
                  tone={
                    recordingState === "recording"
                      ? "danger"
                      : recordingState === "ready"
                        ? "phosphor"
                        : recordingState === "error"
                          ? "warning"
                          : "muted"
                  }
                >
                  {formatSeconds(recordingSeconds)}
                </Badge>
              </div>

              <div className="space-y-4 p-4">
                <div
                  aria-hidden="true"
                  className="flex h-16 items-center gap-[3px] bg-ink-950/40 px-2"
                >
                  {levels.map((level, index) => {
                    const scaled = Math.min(1, Math.sqrt(level) * 2.6);
                    const isActive = recordingState === "recording";
                    const pixels = isActive
                      ? Math.max(3, Math.round(scaled * 52))
                      : 3;
                    return (
                      <span
                        key={index}
                        className={`flex-1 rounded-[1px] transition-[height,background-color] duration-75 ease-out ${
                          isActive
                            ? "bg-phosphor-500/80"
                            : recordingState === "ready"
                              ? "bg-phosphor-500/25"
                              : "bg-ink-500/70"
                        }`}
                        style={{ height: `${pixels}px` }}
                      />
                    );
                  })}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    type="button"
                    onClick={startRecording}
                    disabled={busy || recordingState === "requesting" || recordingState === "recording"}
                    variant={recordingState === "ready" ? "outline" : "primary"}
                  >
                    {recordingState === "requesting" ? "Requesting" : "Record voice"}
                  </Button>
                  <Button
                    type="button"
                    onClick={stopRecording}
                    disabled={recordingState !== "recording"}
                    variant="danger"
                  >
                    Stop recording
                  </Button>
                  <Button
                    type="button"
                    onClick={clearRecording}
                    disabled={busy || (file === undefined && recordedUrl === undefined)}
                    variant="ghost"
                  >
                    Clear audio
                  </Button>
                  <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-bone-300">
                    {recordingStatus}
                  </span>
                </div>

                {recordedUrl !== undefined ? (
                  <audio
                    controls
                    src={recordedUrl}
                    className="w-full accent-phosphor-500"
                  >
                    <track kind="captions" />
                  </audio>
                ) : null}
              </div>
            </div>

            <div>
              <Label htmlFor="audio-file">Audio file</Label>
              <Input
                id="audio-file"
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
                onChange={(event) => {
                  const nextFile = event.currentTarget.files?.[0];
                  setFile(nextFile);
                  if (nextFile !== undefined) {
                    setRecordedUrl((previous) => {
                      if (previous !== undefined) URL.revokeObjectURL(previous);
                      return undefined;
                    });
                    setRecordingState("idle");
                    setRecordingStatus("using uploaded audio file");
                  }
                }}
              />
              {file !== undefined ? (
                <p className="mt-2 font-mono text-[11px] text-bone-300">
                  {file.name} · {Math.ceil(file.size / 1024)} KB
                </p>
              ) : null}
            </div>

            <div>
              <Label htmlFor="audio-model" hint={`${models.length} configured`}>
                Logical model
              </Label>
              <select
                id="audio-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={models.length === 0}
                className="h-9 w-full bg-ink-700 px-3 font-mono text-[12px] text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              >
                {models.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="audio-format">Response format</Label>
                <select
                  id="audio-format"
                  value={responseFormat}
                  onChange={(event) => setResponseFormat(event.target.value)}
                  className="h-9 w-full bg-ink-700 px-3 font-mono text-[12px] text-bone-900 shadow-edge focus:shadow-edge-phosphor focus:outline-none"
                >
                  {FORMATS.map((format) => (
                    <option key={format} value={format}>
                      {format}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <Label htmlFor="audio-language">Language</Label>
                <Input
                  id="audio-language"
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  placeholder="en or en-US"
                  monospace
                />
              </div>
            </div>

            <div>
              <Label htmlFor="audio-prompt">Prompt</Label>
              <Textarea
                id="audio-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Optional vocabulary or context hints"
                className="min-h-[88px]"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <div>
                <Label htmlFor="audio-temp">Temperature</Label>
                <Input
                  id="audio-temp"
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                  placeholder="provider default"
                  monospace
                />
              </div>
              <label className="flex min-w-36 cursor-pointer items-end gap-3 pb-2 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-500">
                <input
                  type="checkbox"
                  checked={stream}
                  onChange={(event) => setStream(event.target.checked)}
                />
                Stream
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3 border-t border-ink-500 pt-4">
              <Button onClick={run} disabled={busy || file === undefined}>
                {busy ? "Running" : "Transcribe"}
              </Button>
              <Button type="button" variant="outline" onClick={stop} disabled={!busy}>
                Stop
              </Button>
              <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.14em] text-bone-300">
                <StatusDot tone={busy ? "phosphor" : status.startsWith("error") ? "danger" : "muted"} />
                {status}
              </span>
            </div>
          </div>
        </Panel>

        <div className="grid min-h-[620px] gap-6 xl:grid-rows-[minmax(320px,1fr)_260px]">
          <Panel
            title="transcript"
            subtitle="Response body from the selected audio route"
            className="min-h-0"
            bodyClassName="min-h-0"
          >
            <div className="flex h-full min-h-0 flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge tone={result !== undefined && result.status < 400 ? "phosphor" : "muted"}>
                  status {result?.status ?? "-"}
                </Badge>
                <Badge tone="muted">{result?.contentType || "no response yet"}</Badge>
              </div>
              <pre className="min-h-0 flex-1 overflow-auto bg-ink-900 p-4 font-mono text-xs leading-6 text-bone-800 shadow-edge">
                {renderResult(result?.body, streamText)}
              </pre>
            </div>
          </Panel>

          <Panel title="events" className="min-h-0" bodyClassName="h-full p-0">
            <EventTimeline
              events={events}
              live={busy}
              onClear={() => setEvents([])}
              compact
            />
          </Panel>
        </div>
      </div>
    </div>
  );
}

function renderResult(body: unknown, streamText: string): string {
  if (streamText.length > 0) return streamText;
  if (body === undefined) return "Record or upload audio and run a transcription.";
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

function formatSeconds(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const dataSize = sampleCount * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}


