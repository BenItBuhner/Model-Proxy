import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { getStorageDir } from "./storage-paths.ts";

let db: Database | undefined;
let dbPath: string | undefined;

export function getOperationalDb(): Database {
  const nextPath = join(getStorageDir("operational"), "model-proxy.sqlite");
  if (db !== undefined && dbPath === nextPath) return db;
  db?.close();
  dbPath = nextPath;
  mkdirSync(dirname(nextPath), { recursive: true });
  db = new Database(nextPath, { create: true });
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db);
  return db;
}

export function closeOperationalDbForTests(): void {
  db?.close();
  db = undefined;
  dbPath = undefined;
}

function runMigrations(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current = database
    .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
    .get() as { version: number } | undefined;
  const version = current?.version ?? 0;
  if (version < 1) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'user')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        completion_logging_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        key_hash TEXT NOT NULL UNIQUE,
        key_prefix TEXT NOT NULL,
        key_last_four TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        scopes TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS signup_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        multi_user_enabled INTEGER NOT NULL DEFAULT 0,
        open_signup_enabled INTEGER NOT NULL DEFAULT 0,
        invite_signup_enabled INTEGER NOT NULL DEFAULT 0,
        default_access_profile_id TEXT,
        default_limits_json TEXT NOT NULL DEFAULT '{}',
        invite_limits_json TEXT NOT NULL DEFAULT '{}',
        allow_user_key_creation INTEGER NOT NULL DEFAULT 1,
        allow_user_completion_logging INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS invites (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        email TEXT,
        access_profile_id TEXT,
        limits_json TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT NOT NULL,
        used_by_user_id TEXT REFERENCES users(id),
        used_at TEXT,
        revoked_at TEXT,
        created_by_user_id TEXT REFERENCES users(id),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT,
        event_type TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      INSERT OR IGNORE INTO signup_settings (id, updated_at) VALUES (1, datetime('now'));
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'));
    `);
  }
  if (version < 2) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS access_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        entitlements_json TEXT NOT NULL DEFAULT '[]',
        limits_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS user_entitlements (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        allowed INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, resource_type, resource_id)
      );

      INSERT INTO schema_migrations (version, applied_at) VALUES (2, datetime('now'));
    `);
  }
  if (version < 3) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS user_limits (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        requests_per_minute INTEGER,
        requests_per_day INTEGER,
        tokens_per_day INTEGER,
        cost_usd_per_day REAL,
        concurrent_requests INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS usage_buckets (
        user_id TEXT NOT NULL,
        bucket_type TEXT NOT NULL,
        bucket_start TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 0,
        token_count INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, bucket_type, bucket_start)
      );

      INSERT INTO schema_migrations (version, applied_at) VALUES (3, datetime('now'));
    `);
  }
  if (version < 4) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS fusion_conversations (
        conversation_id TEXT PRIMARY KEY,
        client TEXT,
        project TEXT,
        principal_id TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fusion_turns (
        turn_id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES fusion_conversations(conversation_id) ON DELETE CASCADE,
        request_id TEXT NOT NULL,
        message_count INTEGER NOT NULL,
        input_fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fusion_runs (
        fusion_run_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        turn_id TEXT NOT NULL REFERENCES fusion_turns(turn_id) ON DELETE CASCADE,
        conversation_id TEXT NOT NULL REFERENCES fusion_conversations(conversation_id) ON DELETE CASCADE,
        logical_model TEXT NOT NULL,
        effort TEXT NOT NULL,
        cache_key TEXT,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        input_fingerprint TEXT NOT NULL,
        config_fingerprint TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS fusion_subagent_runs (
        subagent_run_id TEXT PRIMARY KEY,
        fusion_run_id TEXT NOT NULL REFERENCES fusion_runs(fusion_run_id) ON DELETE CASCADE,
        parent_run_id TEXT,
        subtask_id TEXT NOT NULL,
        focus_area TEXT NOT NULL,
        description_hash TEXT NOT NULL,
        model_routing TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cached', 'skipped')),
        started_at TEXT NOT NULL,
        completed_at TEXT,
        duration_ms INTEGER,
        output_hash TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS fusion_upstream_attempts (
        upstream_attempt_id TEXT PRIMARY KEY,
        parent_run_id TEXT NOT NULL,
        fusion_run_id TEXT NOT NULL REFERENCES fusion_runs(fusion_run_id) ON DELETE CASCADE,
        phase TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        api_key_env_var TEXT,
        route_index INTEGER,
        attempt_number INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
        latency_ms INTEGER,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_fusion_turns_conversation ON fusion_turns(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_fusion_runs_turn ON fusion_runs(turn_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_fusion_runs_request ON fusion_runs(request_id);
      CREATE INDEX IF NOT EXISTS idx_fusion_subagent_runs_fusion ON fusion_subagent_runs(fusion_run_id);
      CREATE INDEX IF NOT EXISTS idx_fusion_upstream_attempts_fusion ON fusion_upstream_attempts(fusion_run_id);

      INSERT INTO schema_migrations (version, applied_at) VALUES (4, datetime('now'));
    `);
  }
  if (version < 5) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS responses (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        messages_json TEXT NOT NULL DEFAULT '[]',
        response_json TEXT NOT NULL,
        store_enabled INTEGER NOT NULL DEFAULT 1,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_responses_owner_created
        ON responses(owner_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_responses_expires
        ON responses(expires_at);
      INSERT INTO schema_migrations (version, applied_at) VALUES (5, datetime('now'));
    `);
  }
  if (version < 6) {
    database.exec(`
      ALTER TABLE responses ADD COLUMN input_json TEXT NOT NULL DEFAULT '[]';
      INSERT INTO schema_migrations (version, applied_at) VALUES (6, datetime('now'));
    `);
  }
  if (version < 7) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS provider_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('oauth', 'token')),
        label TEXT NOT NULL DEFAULT '',
        email TEXT,
        account_id TEXT,
        plan TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        id_token TEXT,
        expires_at TEXT,
        owner_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
        shared INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error', 'disabled')),
        last_error TEXT,
        last_used_at TEXT,
        last_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_provider_accounts_provider
        ON provider_accounts(provider, status);
      CREATE INDEX IF NOT EXISTS idx_provider_accounts_owner
        ON provider_accounts(owner_user_id);

      CREATE TABLE IF NOT EXISTS external_identities (
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, external_id)
      );

      INSERT INTO schema_migrations (version, applied_at) VALUES (7, datetime('now'));
    `);
  }
  if (version < 8) {
    // External SSO identities (Clerk) were removed; drop the unused table.
    database.exec(`
      DROP TABLE IF EXISTS external_identities;
      INSERT INTO schema_migrations (version, applied_at) VALUES (8, datetime('now'));
    `);
  }
}
