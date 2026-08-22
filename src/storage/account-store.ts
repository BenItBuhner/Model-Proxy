import { randomUUID } from "node:crypto";

import { openCredential, sealCredential } from "../accounts/secret-box.ts";
import { getOperationalDb } from "./operational-db.ts";
import type { Principal } from "./identity-store.ts";

export type AccountKind = "oauth" | "token";
export type AccountStatus = "active" | "error" | "disabled";

/**
 * A subscription account attached to a provider (e.g. a ChatGPT/Codex OAuth
 * account, or a pasted SuperGrok token). Accounts feed the router's key pool
 * as `account:<id>` references; tokens never appear in configs or env vars.
 */
export interface ProviderAccount {
  id: string;
  provider: string;
  kind: AccountKind;
  label: string;
  email: string | undefined;
  accountId: string | undefined;
  plan: string | undefined;
  accessToken: string;
  refreshToken: string | undefined;
  idToken: string | undefined;
  /** ISO timestamp when the access token expires (undefined = unknown). */
  expiresAt: string | undefined;
  /** User that attached the account. undefined = server-level (admin) account. */
  ownerUserId: string | undefined;
  /** Shared accounts are usable by every authenticated principal. */
  shared: boolean;
  status: AccountStatus;
  lastError: string | undefined;
  lastUsedAt: string | undefined;
  lastRefreshedAt: string | undefined;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
}

interface AccountRow {
  id: string;
  provider: string;
  kind: AccountKind;
  label: string;
  email: string | null;
  account_id: string | null;
  plan: string | null;
  access_token: string;
  refresh_token: string | null;
  id_token: string | null;
  expires_at: string | null;
  owner_user_id: string | null;
  shared: number;
  status: AccountStatus;
  last_error: string | null;
  last_used_at: string | null;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export const ACCOUNT_REF_PREFIX = "account:";

export function accountRef(accountId: string): string {
  return `${ACCOUNT_REF_PREFIX}${accountId}`;
}

export function parseAccountRef(key: string): string | undefined {
  if (!key.startsWith(ACCOUNT_REF_PREFIX)) return undefined;
  const id = key.slice(ACCOUNT_REF_PREFIX.length);
  return id.length > 0 ? id : undefined;
}

export interface CreateAccountInput {
  provider: string;
  kind: AccountKind;
  label?: string;
  email?: string;
  accountId?: string;
  plan?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string;
  ownerUserId?: string;
  shared?: boolean;
  metadata?: Record<string, unknown>;
}

export function createAccount(input: CreateAccountInput): ProviderAccount {
  const now = new Date().toISOString();
  const row: AccountRow = {
    id: randomUUID(),
    provider: input.provider,
    kind: input.kind,
    label: input.label?.trim() || defaultLabel(input),
    email: input.email ?? null,
    account_id: input.accountId ?? null,
    plan: input.plan ?? null,
    access_token: sealCredential(input.accessToken)!,
    refresh_token: sealCredential(input.refreshToken) ?? null,
    id_token: sealCredential(input.idToken) ?? null,
    expires_at: input.expiresAt ?? null,
    owner_user_id: input.ownerUserId ?? null,
    shared: input.shared === true ? 1 : 0,
    status: "active",
    last_error: null,
    last_used_at: null,
    last_refreshed_at: now,
    created_at: now,
    updated_at: now,
    metadata_json: JSON.stringify(input.metadata ?? {}),
  };
  getOperationalDb()
    .query(
      `INSERT INTO provider_accounts (
        id, provider, kind, label, email, account_id, plan, access_token,
        refresh_token, id_token, expires_at, owner_user_id, shared, status,
        last_error, last_used_at, last_refreshed_at, created_at, updated_at, metadata_json
      ) VALUES (
        $id, $provider, $kind, $label, $email, $account_id, $plan, $access_token,
        $refresh_token, $id_token, $expires_at, $owner_user_id, $shared, $status,
        $last_error, $last_used_at, $last_refreshed_at, $created_at, $updated_at, $metadata_json
      )`,
    )
    .run({
      $id: row.id,
      $provider: row.provider,
      $kind: row.kind,
      $label: row.label,
      $email: row.email,
      $account_id: row.account_id,
      $plan: row.plan,
      $access_token: row.access_token,
      $refresh_token: row.refresh_token,
      $id_token: row.id_token,
      $expires_at: row.expires_at,
      $owner_user_id: row.owner_user_id,
      $shared: row.shared,
      $status: row.status,
      $last_error: row.last_error,
      $last_used_at: row.last_used_at,
      $last_refreshed_at: row.last_refreshed_at,
      $created_at: row.created_at,
      $updated_at: row.updated_at,
      $metadata_json: row.metadata_json,
    });
  return accountFromRow(row);
}

export function getAccount(id: string): ProviderAccount | undefined {
  const row = getOperationalDb()
    .query("SELECT * FROM provider_accounts WHERE id = $id")
    .get({ $id: id }) as AccountRow | null;
  return row === null ? undefined : accountFromRow(row);
}

export function listAccounts(filter: { provider?: string } = {}): ProviderAccount[] {
  const rows =
    filter.provider !== undefined
      ? (getOperationalDb()
          .query(
            "SELECT * FROM provider_accounts WHERE provider = $provider ORDER BY created_at ASC",
          )
          .all({ $provider: filter.provider }) as AccountRow[])
      : (getOperationalDb()
          .query("SELECT * FROM provider_accounts ORDER BY created_at ASC")
          .all() as AccountRow[]);
  return rows.map(accountFromRow);
}

/** Active accounts for a provider, in stable creation order (for rotation). */
export function listActiveAccounts(provider: string): ProviderAccount[] {
  const rows = getOperationalDb()
    .query(
      `SELECT * FROM provider_accounts
       WHERE provider = $provider AND status = 'active'
       ORDER BY created_at ASC`,
    )
    .all({ $provider: provider }) as AccountRow[];
  return rows.map(accountFromRow);
}

/**
 * Whether a principal may route requests through an account.
 *
 * - shared accounts: any principal (including unauthenticated internal calls)
 * - server-level accounts (no owner): owner-bypass principals only
 * - personal accounts: the owning user, plus owner-bypass principals
 */
export function principalCanUseAccount(
  principal: Principal | undefined,
  account: Pick<ProviderAccount, "shared" | "ownerUserId">,
): boolean {
  if (account.shared) return true;
  if (principal?.ownerBypass === true) return true;
  if (account.ownerUserId === undefined) return false;
  return principal?.userId !== undefined && principal.userId === account.ownerUserId;
}

/** Whether a principal may manage (edit/delete/refresh) an account. */
export function principalCanManageAccount(
  principal: Principal | undefined,
  account: Pick<ProviderAccount, "ownerUserId">,
): boolean {
  if (principal === undefined) return false;
  if (principal.ownerBypass || principal.role === "admin") return true;
  return principal.userId !== undefined && principal.userId === account.ownerUserId;
}

export function updateAccountTokens(
  id: string,
  tokens: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    expiresAt?: string;
  },
): ProviderAccount | undefined {
  const now = new Date().toISOString();
  getOperationalDb()
    .query(
      `UPDATE provider_accounts
       SET access_token = $access_token,
           refresh_token = COALESCE($refresh_token, refresh_token),
           id_token = COALESCE($id_token, id_token),
           expires_at = COALESCE($expires_at, expires_at),
           status = 'active',
           last_error = NULL,
           last_refreshed_at = $now,
           updated_at = $now
       WHERE id = $id`,
    )
    .run({
      $access_token: sealCredential(tokens.accessToken)!,
      $refresh_token: sealCredential(tokens.refreshToken) ?? null,
      $id_token: sealCredential(tokens.idToken) ?? null,
      $expires_at: tokens.expiresAt ?? null,
      $now: now,
      $id: id,
    });
  return getAccount(id);
}

export function patchAccount(
  id: string,
  patch: { label?: string; shared?: boolean; status?: AccountStatus },
): ProviderAccount | undefined {
  const existing = getAccount(id);
  if (existing === undefined) return undefined;
  const now = new Date().toISOString();
  getOperationalDb()
    .query(
      `UPDATE provider_accounts
       SET label = $label, shared = $shared, status = $status, updated_at = $now
       WHERE id = $id`,
    )
    .run({
      $label: patch.label ?? existing.label,
      $shared: (patch.shared ?? existing.shared) ? 1 : 0,
      $status: patch.status ?? existing.status,
      $now: now,
      $id: id,
    });
  return getAccount(id);
}

export function markAccountError(id: string, error: string): void {
  const now = new Date().toISOString();
  getOperationalDb()
    .query(
      `UPDATE provider_accounts
       SET status = 'error', last_error = $error, updated_at = $now
       WHERE id = $id`,
    )
    .run({ $error: error.slice(0, 500), $now: now, $id: id });
}

export function touchAccountUsed(id: string): void {
  const now = new Date().toISOString();
  getOperationalDb()
    .query("UPDATE provider_accounts SET last_used_at = $now WHERE id = $id")
    .run({ $now: now, $id: id });
}

export function deleteAccount(id: string): boolean {
  const changes = getOperationalDb()
    .query("DELETE FROM provider_accounts WHERE id = $id")
    .run({ $id: id });
  return changes.changes > 0;
}

function defaultLabel(input: CreateAccountInput): string {
  if (input.email !== undefined && input.email.length > 0) return input.email;
  return `${input.provider} account`;
}

function accountFromRow(row: AccountRow): ProviderAccount {
  return {
    id: row.id,
    provider: row.provider,
    kind: row.kind,
    label: row.label,
    email: row.email ?? undefined,
    accountId: row.account_id ?? undefined,
    plan: row.plan ?? undefined,
    accessToken: openCredential(row.access_token)!,
    refreshToken: openCredential(row.refresh_token ?? undefined),
    idToken: openCredential(row.id_token ?? undefined),
    expiresAt: row.expires_at ?? undefined,
    ownerUserId: row.owner_user_id ?? undefined,
    shared: row.shared === 1,
    status: row.status,
    lastError: row.last_error ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    lastRefreshedAt: row.last_refreshed_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: parseMetadata(row.metadata_json),
  };
}

function parseMetadata(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
