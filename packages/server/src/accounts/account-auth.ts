import { createLogger } from "../observability/logger.ts";
import type { ProviderCallContext } from "../providers/base.ts";
import {
  getAccount,
  markAccountError,
  parseAccountRef,
  touchAccountUsed,
  type ProviderAccount,
} from "../storage/account-store.ts";
import { refreshCodexAccount } from "./codex-oauth.ts";
import { refreshSuperGrokAccount } from "./supergrok-oauth.ts";

const log = createLogger("accounts.auth");
const REFRESH_SKEW_MS = 2 * 60 * 1000;
const refreshes = new Map<string, Promise<ProviderAccount>>();

export function isAccountCredential(value: string): boolean {
  return parseAccountRef(value) !== undefined;
}

/**
 * Turns a router-safe account reference into an access token immediately
 * before the upstream call. Refresh tokens and access tokens never enter route
 * configs, logs, cooldown maps, or observability records.
 */
export async function resolveAccountContext(
  ctx: ProviderCallContext,
  options: { forceRefresh?: boolean } = {},
): Promise<ProviderCallContext> {
  const id = parseAccountRef(ctx.apiKey);
  if (id === undefined) return ctx;
  let account = getAccount(id);
  if (account === undefined) throw new Error("Attached provider account no longer exists");
  if (account.status === "disabled") throw new Error("Attached provider account is disabled");
  if (options.forceRefresh === true || shouldRefresh(account)) {
    account = await refreshAccountOnce(account);
  }
  touchAccountUsed(account.id);
  return {
    ...ctx,
    apiKey: account.accessToken,
    extraHeaders: {
      ...(ctx.extraHeaders ?? {}),
      ...(account.accountId !== undefined
        ? { "ChatGPT-Account-Id": account.accountId }
        : {}),
    },
    accountRef: ctx.apiKey,
  };
}

export async function forceRefreshAccountContext(
  ctx: ProviderCallContext,
): Promise<ProviderCallContext | undefined> {
  if (!isAccountCredential(ctx.accountRef ?? ctx.apiKey)) return undefined;
  const referenced = ctx.accountRef ?? ctx.apiKey;
  return resolveAccountContext({ ...ctx, apiKey: referenced }, { forceRefresh: true });
}

function shouldRefresh(account: ProviderAccount): boolean {
  if (account.kind !== "oauth" || account.refreshToken === undefined) return false;
  if (account.status === "error") return true;
  if (account.expiresAt === undefined) return false;
  return Date.parse(account.expiresAt) <= Date.now() + REFRESH_SKEW_MS;
}

async function refreshAccountOnce(account: ProviderAccount): Promise<ProviderAccount> {
  const existing = refreshes.get(account.id);
  if (existing !== undefined) return existing;
  const promise = refreshAttachedAccount(account)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      markAccountError(account.id, message);
      throw error;
    })
    .finally(() => refreshes.delete(account.id));
  refreshes.set(account.id, promise);
  return promise;
}

export async function refreshAttachedAccount(
  account: ProviderAccount,
): Promise<ProviderAccount> {
  log.info("refreshing provider account", {
    accountId: account.id,
    provider: account.provider,
  });
  if (account.provider === "codex") return refreshCodexAccount(account);
  if (account.provider === "supergrok") return refreshSuperGrokAccount(account);
  throw new Error(`OAuth refresh is not implemented for provider '${account.provider}'`);
}
