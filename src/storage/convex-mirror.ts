import { createHash } from "node:crypto";
import { hostname } from "node:os";

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

import { createLogger } from "../observability/logger.ts";
import {
  listEncryptedAccountMirrorRows,
  onAccountsChanged,
} from "./account-store.ts";

const log = createLogger("storage.convex-mirror");
const DEBOUNCE_MS = 750;

export interface ConvexMirrorStatus {
  configured: boolean;
  syncing: boolean;
  lastSyncedAt: string | undefined;
  lastError: string | undefined;
  accountCount: number;
}

let started = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let rerun = false;
let lastSyncedAt: string | undefined;
let lastError: string | undefined;
let accountCount = 0;

export function startConvexMirror(): void {
  if (started || !isConfigured()) return;
  started = true;
  onAccountsChanged(schedule);
  schedule();
}

export function getConvexMirrorStatus(): ConvexMirrorStatus {
  return {
    configured: isConfigured(),
    syncing,
    lastSyncedAt,
    lastError,
    accountCount,
  };
}

function schedule(): void {
  if (!isConfigured()) return;
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void syncNow();
  }, DEBOUNCE_MS);
}

async function syncNow(): Promise<void> {
  if (syncing) {
    rerun = true;
    return;
  }
  const url = process.env["CONVEX_URL"]?.trim();
  const syncSecret = process.env["CONVEX_SYNC_SECRET"]?.trim();
  if (url === undefined || syncSecret === undefined) return;
  syncing = true;
  try {
    const accounts = removeUndefined(listEncryptedAccountMirrorRows());
    const revision = createHash("sha256")
      .update(JSON.stringify(accounts))
      .digest("hex");
    const client = new ConvexHttpClient(url);
    await client.mutation(anyApi.providerAccounts.reconcile, {
      syncSecret,
      sourceInstance: sourceInstance(),
      revision,
      accounts,
    });
    accountCount = accounts.length;
    lastSyncedAt = new Date().toISOString();
    lastError = undefined;
    log.info("Convex account mirror synchronized", { accountCount });
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    log.warn("Convex account mirror failed", { error: lastError });
  } finally {
    syncing = false;
    if (rerun) {
      rerun = false;
      schedule();
    }
  }
}

function isConfigured(): boolean {
  return Boolean(
    process.env["CONVEX_URL"]?.trim() &&
      process.env["CONVEX_SYNC_SECRET"]?.trim(),
  );
}

function sourceInstance(): string {
  return (
    process.env["MODEL_PROXY_INSTANCE_ID"]?.trim() ||
    process.env["MODEL_PROXY_BUILD_ID"]?.trim() ||
    hostname()
  );
}

function removeUndefined(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([, value]) => value !== undefined)),
  );
}

export function resetConvexMirrorForTests(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  started = false;
  syncing = false;
  rerun = false;
  lastSyncedAt = undefined;
  lastError = undefined;
  accountCount = 0;
}
