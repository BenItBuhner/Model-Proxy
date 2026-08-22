"use client";

import { getStoredApiKey } from "./api";
import { generateRequestId } from "./test-dispatch";

export interface AudioModelList {
  object: "list";
  data: Array<{
    id: string;
    object: "model";
    created: number;
    owned_by: string;
  }>;
}

export interface AudioTranscriptionOptions {
  requestId?: string;
  model: string;
  file: File;
  responseFormat: string;
  language: string;
  prompt: string;
  temperature: string;
  stream: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export interface AudioTranscriptionResult {
  requestId: string;
  status: number;
  contentType: string;
  body: unknown;
}

export async function listAudioModels(): Promise<AudioModelList> {
  const res = await fetch("/v1/audio/models", {
    credentials: "include",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`Unable to load audio models (${res.status})`);
  return (await res.json()) as AudioModelList;
}

export async function transcribeAudio(
  options: AudioTranscriptionOptions,
): Promise<AudioTranscriptionResult> {
  const requestId = options.requestId ?? generateRequestId();
  const form = new FormData();
  form.set("model", options.model);
  form.set("file", options.file);
  form.set("response_format", options.responseFormat);
  if (options.language.trim().length > 0) form.set("language", options.language.trim());
  if (options.prompt.trim().length > 0) form.set("prompt", options.prompt.trim());
  if (options.temperature.trim().length > 0) {
    form.set("temperature", options.temperature.trim());
  }
  if (options.stream) form.set("stream", "true");

  const res = await fetch("/v1/audio/transcriptions", {
    method: "POST",
    credentials: "include",
    headers: {
      ...authHeaders(),
      "x-request-id": requestId,
    },
    body: form,
    signal: options.signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (options.stream && res.body !== null) {
    const text = await readStream(res.body, options.onChunk);
    return { requestId, status: res.status, contentType, body: text };
  }

  const text = await res.text();
  let body: unknown = text;
  if (contentType.includes("application/json") && text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { requestId, status: res.status, contentType, body };
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    text += chunk;
    onChunk?.(chunk);
  }
  text += decoder.decode();
  return text;
}

function authHeaders(): Record<string, string> {
  const key = getStoredApiKey();
  return key !== undefined ? { Authorization: `Bearer ${key}` } : {};
}

