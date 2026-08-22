/**
 * Persistent previous_response_id store for Responses API chaining.
 *
 * HTTP: SQLite is authoritative and an in-memory LRU keeps hot responses fast.
 * Responses are retained only when the client leaves store enabled.
 *
 * WebSocket: each connection also keeps a connection-local cache (see
 * responses-ws.ts) for the same store-enabled behavior.
 */

import { getOperationalDb } from "../storage/operational-db.ts";

export interface StoredResponseEntry {
  id: string;
  /** Principal identity used to prevent cross-user response lookup. */
  ownerId?: string;
  model: string;
  createdAt: number;
  status: string;
  /** Full chat-message history after this response (includes assistant output). */
  messages: Array<Record<string, unknown>>;
  /** Canonical Responses input/output items used for native chaining. */
  inputItems?: unknown[];
  tools?: unknown[];
  instructions?: string;
  /** Snapshot of the Responses object returned to the client. */
  response: Record<string, unknown>;
  store: boolean;
}

export interface ResponseStoreOptions {
  maxEntries?: number;
  ttlMs?: number;
}

const DEFAULT_MAX = 512;
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

export class ResponseStore {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly map = new Map<string, StoredResponseEntry>();

  constructor(options: ResponseStoreOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  get size(): number {
    return this.map.size;
  }

  get(id: string, ownerId?: string): StoredResponseEntry | undefined {
    this.evictExpired();
    let entry = this.map.get(id);
    if (entry === undefined) {
      const row = getOperationalDb().query(
        `SELECT id, owner_id, model, created_at, status, messages_json, response_json, store_enabled, input_json
         FROM responses WHERE id = $id AND expires_at > $now`,
      ).get({ $id: id, $now: new Date().toISOString() }) as ResponseRow | null;
      if (row !== null) {
        const loaded = rowToEntry(row);
        if (loaded !== undefined) {
          entry = loaded;
          this.map.set(id, loaded);
        }
      }
    }
    if (entry === undefined) return undefined;
    if (ownerId !== undefined && entry.ownerId !== ownerId) {
      return undefined;
    }
    if (Date.now() - entry.createdAt * 1000 > this.ttlMs) {
      this.map.delete(id);
      return undefined;
    }
    // LRU touch
    this.map.delete(id);
    this.map.set(id, entry);
    return entry;
  }

  set(entry: StoredResponseEntry): void {
    this.evictExpired();
    if (this.map.has(entry.id)) this.map.delete(entry.id);
    this.map.set(entry.id, entry);
    const expiresAt = new Date(entry.createdAt * 1000 + this.ttlMs).toISOString();
    getOperationalDb().query(
      `INSERT INTO responses (
         id, owner_id, model, created_at, status, messages_json, response_json, store_enabled, input_json, expires_at
       ) VALUES (
         $id, $owner_id, $model, $created_at, $status, $messages_json, $response_json, $store_enabled, $input_json, $expires_at
       ) ON CONFLICT(id) DO UPDATE SET
         owner_id = excluded.owner_id,
         model = excluded.model,
         created_at = excluded.created_at,
         status = excluded.status,
         messages_json = excluded.messages_json,
         response_json = excluded.response_json,
         store_enabled = excluded.store_enabled,
         input_json = excluded.input_json,
         expires_at = excluded.expires_at`,
    ).run({
      $id: entry.id,
      $owner_id: entry.ownerId ?? null,
      $model: entry.model,
      $created_at: entry.createdAt,
      $status: entry.status,
      $messages_json: JSON.stringify(entry.messages),
      $response_json: JSON.stringify(entry.response),
      $store_enabled: entry.store ? 1 : 0,
      $input_json: JSON.stringify(entry.inputItems ?? []),
      $expires_at: expiresAt,
    });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(id: string, ownerId?: string): void {
    const existing = this.get(id, ownerId);
    if (existing === undefined) return;
    this.map.delete(id);
    getOperationalDb().query("DELETE FROM responses WHERE id = $id").run({ $id: id });
  }

  clear(): void {
    this.map.clear();
    getOperationalDb().exec("DELETE FROM responses");
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.map) {
      if (now - entry.createdAt * 1000 > this.ttlMs) {
        this.map.delete(id);
      }
    }
    getOperationalDb().query("DELETE FROM responses WHERE expires_at <= $now").run({
      $now: new Date(now).toISOString(),
    });
  }
}

interface ResponseRow {
  id: string;
  owner_id: string | null;
  model: string;
  created_at: number;
  status: string;
  messages_json: string;
  response_json: string;
  store_enabled: number;
  input_json: string;
}

function rowToEntry(row: ResponseRow): StoredResponseEntry | undefined {
  try {
    const messages = JSON.parse(row.messages_json) as unknown;
    const response = JSON.parse(row.response_json) as unknown;
    const inputItems = JSON.parse(row.input_json) as unknown;
    if (!Array.isArray(messages) || !Array.isArray(inputItems) || typeof response !== "object" || response === null || Array.isArray(response)) {
      return undefined;
    }
    return {
      id: row.id,
      ownerId: row.owner_id ?? undefined,
      model: row.model,
      createdAt: row.created_at,
      status: row.status,
      messages: messages as Array<Record<string, unknown>>,
      inputItems,
      response: response as Record<string, unknown>,
      store: row.store_enabled !== 0,
    };
  } catch {
    return undefined;
  }
}

/** Process-global HTTP / shared fallback store. */
let globalStore: ResponseStore | undefined;

export function getGlobalResponseStore(): ResponseStore {
  if (globalStore === undefined) {
    const maxEntries = parsePositiveInt(process.env.RESPONSES_STORE_MAX_ENTRIES) ?? DEFAULT_MAX;
    const ttlMs = parsePositiveInt(process.env.RESPONSES_STORE_TTL_MS) ?? DEFAULT_TTL_MS;
    globalStore = new ResponseStore({ maxEntries, ttlMs });
  }
  return globalStore;
}

/** Test helper. */
export function resetGlobalResponseStoreForTests(options?: ResponseStoreOptions): ResponseStore {
  globalStore = new ResponseStore(options ?? {});
  return globalStore;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export function previousResponseNotFoundError(id: string): Record<string, unknown> {
  return {
    error: {
      message: `Previous response with id '${id}' not found.`,
      type: "invalid_request_error",
      code: "previous_response_not_found",
      param: "previous_response_id",
    },
  };
}
