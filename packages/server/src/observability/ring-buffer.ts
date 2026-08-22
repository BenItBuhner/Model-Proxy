/**
 * In-memory request observability records for the current process lifetime.
 *
 * No DB, no disk. Designed for the admin UI dashboard to show recent requests
 * without ever persisting completion content. The record wire shape lives in
 * `@model-proxy/contracts` so the web UI consumes the exact same type.
 */

import type { RequestLogRecord } from "@model-proxy/contracts/api/log-records.ts";

export type { RequestLogRecord } from "@model-proxy/contracts/api/log-records.ts";

class RuntimeRequestStore<T> {
  private readonly capacity: number | undefined;
  private entries: T[];

  constructor(capacity?: number) {
    if (capacity !== undefined && capacity <= 0) throw new Error("Capacity must be positive");
    this.capacity = capacity;
    this.entries = [];
  }

  push(item: T): void {
    this.entries.push(item);
    if (this.capacity !== undefined && this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** Returns items in reverse-chronological order (newest first). */
  snapshot(limit?: number, offset = 0): T[] {
    const safeOffset = Math.max(0, offset);
    const count =
      limit === undefined ? Math.max(0, this.entries.length - safeOffset) : Math.max(0, limit);
    return this.entries
      .slice()
      .reverse()
      .slice(safeOffset, safeOffset + count);
  }

  clear(): void {
    this.entries = [];
  }

  get length(): number {
    return this.entries.length;
  }
}

const capacity = parseOptionalPositiveInt(process.env.REQUEST_LOG_CAPACITY) ?? 1_000;
const globalBuffer = new RuntimeRequestStore<RequestLogRecord>(capacity);

export const requestLogRingBuffer = {
  record(entry: RequestLogRecord): void {
    globalBuffer.push(entry);
  },
  recent(limit?: number, offset = 0): RequestLogRecord[] {
    return globalBuffer.snapshot(limit, offset);
  },
  clear(): void {
    globalBuffer.clear();
  },
  get size(): number {
    return globalBuffer.length;
  },
};

function parseOptionalPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
