/**
 * In-memory ring buffer of recent request observability records.
 *
 * No DB, no disk. Designed for the admin UI dashboard to show recent requests
 * without ever persisting completion content.
 */

export interface RequestLogRecord {
  requestId: string;
  timestamp: string;
  completedAt: string | undefined;
  endpoint: string;
  method: string;
  requestedModel: string;
  resolvedProvider: string | undefined;
  resolvedModel: string | undefined;
  wireProtocol: "openai" | "anthropic" | "audio" | undefined;
  state: "running" | "completed";
  responseStatus: number | undefined;
  responseTimeMs: number | undefined;
  elapsedMs: number;
  isStreaming: boolean;
  enforceMode: boolean;
  retryCount: number;
  errorMessage: string | undefined;
  errorType: string | undefined;
  promptTokens: number | undefined;
  promptTokensEstimated: boolean | undefined;
  completionTokens: number | undefined;
  totalTokens: number | undefined;
  streamChunkCount: number | undefined;
  streamBytes: number | undefined;
}

const DEFAULT_CAPACITY = 1000;

class RingBuffer<T> {
  private readonly capacity: number;
  private buffer: (T | undefined)[];
  private head: number;
  private size: number;

  constructor(capacity: number) {
    if (capacity <= 0) throw new Error("Capacity must be positive");
    this.capacity = capacity;
    this.buffer = new Array<T | undefined>(capacity);
    this.head = 0;
    this.size = 0;
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Returns items in reverse-chronological order (newest first). */
  snapshot(limit?: number): T[] {
    const count = limit === undefined ? this.size : Math.min(limit, this.size);
    const out: T[] = [];
    for (let i = 0; i < count; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  clear(): void {
    this.buffer = new Array<T | undefined>(this.capacity);
    this.head = 0;
    this.size = 0;
  }

  get length(): number {
    return this.size;
  }
}

const capacity = Number.parseInt(
  process.env.REQUEST_LOG_CAPACITY ?? String(DEFAULT_CAPACITY),
  10,
);
const globalBuffer = new RingBuffer<RequestLogRecord>(
  Number.isFinite(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY,
);

export const requestLogRingBuffer = {
  record(entry: RequestLogRecord): void {
    globalBuffer.push(entry);
  },
  recent(limit?: number): RequestLogRecord[] {
    return globalBuffer.snapshot(limit);
  },
  clear(): void {
    globalBuffer.clear();
  },
  get size(): number {
    return globalBuffer.length;
  },
};
