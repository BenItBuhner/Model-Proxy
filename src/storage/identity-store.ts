import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

import { getOperationalDb } from "./operational-db.ts";

export type UserRole = "owner" | "admin" | "user";
export type UserStatus = "active" | "disabled";

export interface Principal {
  id: string;
  userId: string | undefined;
  apiKeyId: string | undefined;
  email: string | undefined;
  role: UserRole;
  isOwner: boolean;
  scopes: string[];
  authMethod: "legacy-client-key" | "api-key" | "session" | "no-auth";
  ownerBypass: boolean;
  completionLoggingEnabled: boolean;
}

export interface StoredUser {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  completionLoggingEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | undefined;
}

export interface SignupSettings {
  multiUserEnabled: boolean;
  openSignupEnabled: boolean;
  inviteSignupEnabled: boolean;
  defaultAccessProfileId: string | undefined;
  defaultLimits: Record<string, unknown>;
  inviteLimits: Record<string, unknown>;
  allowUserKeyCreation: boolean;
  allowUserCompletionLogging: boolean;
  updatedAt: string;
}

export interface ApiKeyCreation {
  id: string;
  key: string;
  keyPrefix: string;
  keyLastFour: string;
}

export interface ApiKeySummary {
  id: string;
  keyPrefix: string;
  keyLastFour: string;
  label: string;
  scopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | undefined;
  revokedAt: string | undefined;
}

export interface StoredInvite {
  id: string;
  email: string | undefined;
  accessProfileId: string | undefined;
  limits: Record<string, unknown>;
  expiresAt: string;
  usedByUserId: string | undefined;
  usedAt: string | undefined;
  revokedAt: string | undefined;
  createdByUserId: string | undefined;
  createdAt: string;
}

export interface InviteCreation {
  invite: StoredInvite;
  token: string;
}

interface UserRow {
  id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  completion_logging_enabled: number;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  completion_logging_enabled: number;
  scopes: string;
}

interface ApiKeySummaryRow {
  id: string;
  key_prefix: string;
  key_last_four: string;
  label: string;
  scopes: string;
  status: "active" | "revoked";
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface SessionRow {
  user_id: string;
  email: string;
  role: UserRole;
  status: UserStatus;
  completion_logging_enabled: number;
}

interface InviteRow {
  id: string;
  email: string | null;
  access_profile_id: string | null;
  limits_json: string;
  expires_at: string;
  used_by_user_id: string | null;
  used_at: string | null;
  revoked_at: string | null;
  created_by_user_id: string | null;
  created_at: string;
}

const API_KEY_PREFIX = "mpu";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PASSWORD_SCRYPT_OPTIONS = { N: 4096, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function ownerUserExists(): boolean {
  const row = getOperationalDb()
    .query("SELECT id FROM users WHERE role = 'owner' LIMIT 1")
    .get() as { id: string } | null;
  return row !== null;
}

export function listUsers(): StoredUser[] {
  const rows = getOperationalDb()
    .query("SELECT * FROM users ORDER BY created_at DESC")
    .all() as UserRow[];
  return rows.map(userFromRow);
}

export function createUser(input: {
  email: string;
  password: string;
  role?: UserRole;
  completionLoggingEnabled?: boolean;
}): StoredUser {
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    email: normalizeEmail(input.email),
    password_hash: hashPassword(input.password),
    role: input.role ?? "user",
    status: "active",
    completion_logging_enabled: input.completionLoggingEnabled === true ? 1 : 0,
    created_at: now,
    updated_at: now,
  };
  getOperationalDb()
    .query(
      `INSERT INTO users (
        id, email, password_hash, role, status, completion_logging_enabled, created_at, updated_at
      ) VALUES (
        $id, $email, $password_hash, $role, $status, $completion_logging_enabled, $created_at, $updated_at
      )`,
    )
    .run({
      $id: row.id,
      $email: row.email,
      $password_hash: row.password_hash,
      $role: row.role,
      $status: row.status,
      $completion_logging_enabled: row.completion_logging_enabled,
      $created_at: row.created_at,
      $updated_at: row.updated_at,
    });
  return userFromRow({ ...row, last_login_at: null } as UserRow);
}

export function verifyEmailPassword(email: string, password: string): StoredUser | undefined {
  const row = getOperationalDb()
    .query("SELECT * FROM users WHERE email = $email")
    .get({ $email: normalizeEmail(email) }) as (UserRow & { password_hash: string }) | null;
  if (row === null || row.status !== "active") return undefined;
  if (!verifyPassword(password, row.password_hash)) return undefined;
  const now = new Date().toISOString();
  getOperationalDb()
    .query("UPDATE users SET last_login_at = $now, updated_at = $now WHERE id = $id")
    .run({ $now: now, $id: row.id });
  return userFromRow({ ...row, last_login_at: now, updated_at: now });
}

export function createSession(userId: string): { sessionId: string; token: string; expiresAt: string } {
  const token = randomSecret(32);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  const sessionId = randomUUID();
  getOperationalDb()
    .query(
      `INSERT INTO sessions (id, token_hash, user_id, expires_at, created_at)
       VALUES ($id, $token_hash, $user_id, $expires_at, $created_at)`,
    )
    .run({
      $id: sessionId,
      $token_hash: hashSecret(token),
      $user_id: userId,
      $expires_at: expiresAt,
      $created_at: now.toISOString(),
    });
  return { sessionId, token, expiresAt };
}

export function authenticateSessionToken(token: string | undefined): Principal | undefined {
  if (token === undefined || token.trim() === "") return undefined;
  const row = getOperationalDb()
    .query(
      `SELECT sessions.user_id, users.email, users.role, users.status, users.completion_logging_enabled
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $token_hash
         AND sessions.revoked_at IS NULL
         AND sessions.expires_at > $now`,
    )
    .get({ $token_hash: hashSecret(token), $now: new Date().toISOString() }) as SessionRow | null;
  if (row === null || row.status !== "active") return undefined;
  getOperationalDb()
    .query("UPDATE sessions SET last_seen_at = $now WHERE token_hash = $token_hash")
    .run({ $now: new Date().toISOString(), $token_hash: hashSecret(token) });
  return principalFromUserRow(row, { authMethod: "session" });
}

export function revokeSessionToken(token: string | undefined): void {
  if (token === undefined || token.trim() === "") return;
  getOperationalDb()
    .query("UPDATE sessions SET revoked_at = $now WHERE token_hash = $token_hash")
    .run({ $now: new Date().toISOString(), $token_hash: hashSecret(token) });
}

export function createUserApiKey(input: {
  userId: string;
  label?: string;
  scopes?: string[];
}): ApiKeyCreation {
  const raw = `${API_KEY_PREFIX}_${randomSecret(32)}`;
  const now = new Date().toISOString();
  const id = randomUUID();
  const keyPrefix = raw.slice(0, 12);
  const keyLastFour = raw.slice(-4);
  getOperationalDb()
    .query(
      `INSERT INTO api_keys (
        id, key_hash, key_prefix, key_last_four, user_id, label, scopes, created_at
      ) VALUES (
        $id, $key_hash, $key_prefix, $key_last_four, $user_id, $label, $scopes, $created_at
      )`,
    )
    .run({
      $id: id,
      $key_hash: hashSecret(raw),
      $key_prefix: keyPrefix,
      $key_last_four: keyLastFour,
      $user_id: input.userId,
      $label: input.label?.trim() || "Default key",
      $scopes: JSON.stringify(input.scopes ?? ["inference"]),
      $created_at: now,
    });
  return { id, key: raw, keyPrefix, keyLastFour };
}

export function listUserApiKeys(userId: string): ApiKeySummary[] {
  const rows = getOperationalDb()
    .query(
      `SELECT id, key_prefix, key_last_four, label, scopes, status, created_at, last_used_at, revoked_at
       FROM api_keys
       WHERE user_id = $user_id
       ORDER BY created_at DESC`,
    )
    .all({ $user_id: userId }) as ApiKeySummaryRow[];
  return rows.map((row) => ({
    id: row.id,
    keyPrefix: row.key_prefix,
    keyLastFour: row.key_last_four,
    label: row.label,
    scopes: parseScopes(row.scopes),
    status: row.status,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
  }));
}

export function listInvites(): StoredInvite[] {
  const rows = getOperationalDb()
    .query("SELECT * FROM invites ORDER BY created_at DESC")
    .all() as InviteRow[];
  return rows.map(inviteFromRow);
}

export function createInvite(input: {
  email?: string;
  accessProfileId?: string;
  limits?: Record<string, unknown>;
  expiresAt?: string;
  createdByUserId?: string;
}): InviteCreation {
  const token = randomSecret(32);
  const now = new Date();
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + 1000 * 60 * 60 * 24 * 7).toISOString();
  const row = {
    id: randomUUID(),
    token_hash: hashSecret(token),
    email: input.email !== undefined && input.email.trim() !== "" ? normalizeEmail(input.email) : null,
    access_profile_id: input.accessProfileId ?? null,
    limits_json: JSON.stringify(input.limits ?? {}),
    expires_at: expiresAt,
    created_by_user_id: input.createdByUserId ?? null,
    created_at: now.toISOString(),
  };
  getOperationalDb()
    .query(
      `INSERT INTO invites (
        id, token_hash, email, access_profile_id, limits_json, expires_at, created_by_user_id, created_at
      ) VALUES (
        $id, $token_hash, $email, $access_profile_id, $limits_json, $expires_at, $created_by_user_id, $created_at
      )`,
    )
    .run({
      $id: row.id,
      $token_hash: row.token_hash,
      $email: row.email,
      $access_profile_id: row.access_profile_id,
      $limits_json: row.limits_json,
      $expires_at: row.expires_at,
      $created_by_user_id: row.created_by_user_id,
      $created_at: row.created_at,
    });
  return {
    token,
    invite: inviteFromRow({
      ...row,
      used_by_user_id: null,
      used_at: null,
      revoked_at: null,
    }),
  };
}

export function consumeInvite(token: string, userId: string, email: string): StoredInvite | undefined {
  const db = getOperationalDb();
  const now = new Date().toISOString();
  const row = db
    .query(
      `SELECT * FROM invites
       WHERE token_hash = $token_hash
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > $now`,
    )
    .get({ $token_hash: hashSecret(token), $now: now }) as InviteRow | null;
  if (row === null) return undefined;
  if (row.email !== null && row.email !== normalizeEmail(email)) return undefined;
  db.query("UPDATE invites SET used_by_user_id = $user_id, used_at = $now WHERE id = $id")
    .run({ $user_id: userId, $now: now, $id: row.id });
  return inviteFromRow({ ...row, used_by_user_id: userId, used_at: now });
}

export function isInviteUsable(token: string, email: string): boolean {
  const now = new Date().toISOString();
  const row = getOperationalDb()
    .query(
      `SELECT email FROM invites
       WHERE token_hash = $token_hash
         AND used_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > $now`,
    )
    .get({ $token_hash: hashSecret(token), $now: now }) as { email: string | null } | null;
  if (row === null) return false;
  return row.email === null || row.email === normalizeEmail(email);
}

export function authenticateApiKey(key: string | undefined): Principal | undefined {
  if (key === undefined || key.trim() === "") return undefined;
  const row = getOperationalDb()
    .query(
      `SELECT api_keys.id, api_keys.user_id, users.email, users.role, users.status,
              users.completion_logging_enabled, api_keys.scopes
       FROM api_keys
       JOIN users ON users.id = api_keys.user_id
       WHERE api_keys.key_hash = $key_hash
         AND api_keys.status = 'active'`,
    )
    .get({ $key_hash: hashSecret(key.trim()) }) as ApiKeyRow | null;
  if (row === null || row.status !== "active") return undefined;
  getOperationalDb()
    .query("UPDATE api_keys SET last_used_at = $now WHERE id = $id")
    .run({ $now: new Date().toISOString(), $id: row.id });
  return principalFromUserRow(row, {
    authMethod: "api-key",
    apiKeyId: row.id,
    scopes: parseScopes(row.scopes),
  });
}

export function readSignupSettings(): SignupSettings {
  const row = getOperationalDb()
    .query("SELECT * FROM signup_settings WHERE id = 1")
    .get() as Record<string, unknown>;
  return {
    multiUserEnabled: Boolean(row["multi_user_enabled"]),
    openSignupEnabled: Boolean(row["open_signup_enabled"]),
    inviteSignupEnabled: Boolean(row["invite_signup_enabled"]),
    defaultAccessProfileId:
      typeof row["default_access_profile_id"] === "string"
        ? row["default_access_profile_id"]
        : undefined,
    defaultLimits: parseJsonObject(row["default_limits_json"]),
    inviteLimits: parseJsonObject(row["invite_limits_json"]),
    allowUserKeyCreation: Boolean(row["allow_user_key_creation"]),
    allowUserCompletionLogging: Boolean(row["allow_user_completion_logging"]),
    updatedAt: String(row["updated_at"] ?? new Date().toISOString()),
  };
}

export function writeSignupSettings(input: Partial<SignupSettings>): SignupSettings {
  const current = readSignupSettings();
  const next: SignupSettings = {
    multiUserEnabled: input.multiUserEnabled ?? current.multiUserEnabled,
    openSignupEnabled: input.openSignupEnabled ?? current.openSignupEnabled,
    inviteSignupEnabled: input.inviteSignupEnabled ?? current.inviteSignupEnabled,
    defaultAccessProfileId: input.defaultAccessProfileId ?? current.defaultAccessProfileId,
    defaultLimits: input.defaultLimits ?? current.defaultLimits,
    inviteLimits: input.inviteLimits ?? current.inviteLimits,
    allowUserKeyCreation: input.allowUserKeyCreation ?? current.allowUserKeyCreation,
    allowUserCompletionLogging: input.allowUserCompletionLogging ?? current.allowUserCompletionLogging,
    updatedAt: new Date().toISOString(),
  };
  getOperationalDb()
    .query(
      `UPDATE signup_settings
       SET multi_user_enabled = $multi_user_enabled,
           open_signup_enabled = $open_signup_enabled,
           invite_signup_enabled = $invite_signup_enabled,
           default_access_profile_id = $default_access_profile_id,
           default_limits_json = $default_limits_json,
           invite_limits_json = $invite_limits_json,
           allow_user_key_creation = $allow_user_key_creation,
           allow_user_completion_logging = $allow_user_completion_logging,
           updated_at = $updated_at
       WHERE id = 1`,
    )
    .run({
      $multi_user_enabled: next.multiUserEnabled ? 1 : 0,
      $open_signup_enabled: next.openSignupEnabled ? 1 : 0,
      $invite_signup_enabled: next.inviteSignupEnabled ? 1 : 0,
      $default_access_profile_id: next.defaultAccessProfileId ?? null,
      $default_limits_json: JSON.stringify(next.defaultLimits),
      $invite_limits_json: JSON.stringify(next.inviteLimits),
      $allow_user_key_creation: next.allowUserKeyCreation ? 1 : 0,
      $allow_user_completion_logging: next.allowUserCompletionLogging ? 1 : 0,
      $updated_at: next.updatedAt,
    });
  return next;
}

export function legacyOwnerPrincipal(): Principal {
  return {
    id: "legacy-owner",
    userId: undefined,
    apiKeyId: undefined,
    email: undefined,
    role: "owner",
    isOwner: true,
    scopes: ["*"],
    authMethod: "legacy-client-key",
    ownerBypass: true,
    completionLoggingEnabled: true,
  };
}

export function recordAuditEvent(input: {
  actorUserId?: string;
  eventType: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}): void {
  getOperationalDb()
    .query(
      `INSERT INTO audit_events (
        id, actor_user_id, event_type, target_type, target_id, details_json, created_at
      ) VALUES (
        $id, $actor_user_id, $event_type, $target_type, $target_id, $details_json, $created_at
      )`,
    )
    .run({
      $id: randomUUID(),
      $actor_user_id: input.actorUserId ?? null,
      $event_type: input.eventType,
      $target_type: input.targetType ?? null,
      $target_id: input.targetId ?? null,
      $details_json: JSON.stringify(input.details ?? {}),
      $created_at: new Date().toISOString(),
    });
}

export function noAuthPrincipal(): Principal {
  return {
    id: "no-auth-owner",
    userId: undefined,
    apiKeyId: undefined,
    email: undefined,
    role: "owner",
    isOwner: true,
    scopes: ["*"],
    authMethod: "no-auth",
    ownerBypass: true,
    completionLoggingEnabled: true,
  };
}

function principalFromUserRow(
  row: {
    user_id: string;
    email: string;
    role: UserRole;
    completion_logging_enabled: number;
  },
  options: { authMethod: "api-key" | "session"; apiKeyId?: string; scopes?: string[] },
): Principal {
  const isOwner = row.role === "owner";
  return {
    id: options.apiKeyId ?? row.user_id,
    userId: row.user_id,
    apiKeyId: options.apiKeyId,
    email: row.email,
    role: row.role,
    isOwner,
    scopes: options.scopes ?? ["dashboard"],
    authMethod: options.authMethod,
    ownerBypass: isOwner,
    completionLoggingEnabled: row.completion_logging_enabled === 1,
  };
}

function userFromRow(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
    completionLoggingEnabled: row.completion_logging_enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined,
  };
}

function inviteFromRow(row: InviteRow): StoredInvite {
  return {
    id: row.id,
    email: row.email ?? undefined,
    accessProfileId: row.access_profile_id ?? undefined,
    limits: parseJsonObject(row.limits_json),
    expiresAt: row.expires_at,
    usedByUserId: row.used_by_user_id ?? undefined,
    usedAt: row.used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    createdByUserId: row.created_by_user_id ?? undefined,
    createdAt: row.created_at,
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function randomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("base64url");
  const key = scryptSync(password, salt, 64, PASSWORD_SCRYPT_OPTIONS).toString("base64url");
  return `scrypt$${salt}$${key}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, encoded] = stored.split("$");
  if (scheme !== "scrypt" || salt === undefined || encoded === undefined) return false;
  const expected = Buffer.from(encoded, "base64url");
  const actual = scryptSync(password, salt, expected.length, PASSWORD_SCRYPT_OPTIONS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
