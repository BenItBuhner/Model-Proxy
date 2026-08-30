import { readJsonObject } from "../read-json-object.ts";
import { isSameOriginMutation } from "../same-origin.ts";
import { Hono } from "hono";

import { refreshAttachedAccount } from "../../accounts/account-auth.ts";
import {
  beginCodexBrowserFlow,
  beginCodexDeviceFlow,
  completeCodexBrowserFlow,
  importCodexAuthFile,
  pollCodexDeviceFlow,
  type CodexDeviceFlow,
} from "../../accounts/codex-oauth.ts";
import {
  beginSuperGrokDeviceFlow,
  pollSuperGrokDeviceFlow,
  type SuperGrokDeviceFlow,
} from "../../accounts/supergrok-oauth.ts";
import { providerRegistry } from "../../providers/registry.ts";
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccounts,
  patchAccount,
  principalCanManageAccount,
  principalCanUseAccount,
  type ProviderAccount,
} from "../../storage/account-store.ts";
import { recordAuditEvent, type Principal } from "../../storage/identity-store.ts";
import { principal, requireAuth } from "../auth.ts";

const codexDeviceFlows = new Map<string, CodexDeviceFlow>();
const superGrokDeviceFlows = new Map<string, SuperGrokDeviceFlow>();

function pruneExpiredDeviceFlows(): void {
  const now = Date.now();
  for (const [id, flow] of codexDeviceFlows) {
    if (Date.parse(flow.expiresAt) <= now) codexDeviceFlows.delete(id);
  }
  for (const [id, flow] of superGrokDeviceFlows) {
    if (Date.parse(flow.expiresAt) <= now) superGrokDeviceFlows.delete(id);
  }
}

export function createAccountRoutes(): Hono {
  const app = new Hono();
  const gate: Parameters<Hono["use"]>[1] = async (c, next) => {
    if (!isSameOriginMutation(c)) return c.json({ error: "Cross-origin mutation denied" }, 403);
    return requireAuth({ allowSession: true })(c, next);
  };
  app.use("/v1/accounts", gate);
  app.use("/v1/accounts/*", gate);

  app.get("/v1/accounts", (c) => {
    const actor = principal(c);
    return c.json({
      accounts: listAccounts()
        .filter(
          (account) =>
            principalCanUseAccount(actor, account) ||
            principalCanManageAccount(actor, account),
        )
        .map((account) => publicAccount(account, actor)),
    });
  });

  app.get("/v1/accounts/status", (c) => {
    return c.json({
      credential_encryption: "aes-256-gcm",
    });
  });

  app.post("/v1/accounts/token", async (c) => {
    const actor = principal(c);
    if (actor === undefined) return c.json({ error: "Unauthorized" }, 401);
    const body = await readJsonObject(c);
    const provider = optionalString(body["provider"]);
    const accessToken = optionalString(body["access_token"]);
    if (provider === undefined || accessToken === undefined) {
      return c.json({ error: "provider and access_token are required" }, 400);
    }
    const shared = body["shared"] === true;
    if (shared && !isAdmin(actor)) return c.json({ error: "Only admins can share accounts" }, 403);
    if (!providerRegistry.isValidProvider(provider)) {
      return c.json({ error: `Unknown provider '${provider}'` }, 400);
    }
    const account = createAccount({
      provider,
      kind: "token",
      label: optionalString(body["label"]),
      email: optionalString(body["email"]),
      accessToken,
      ownerUserId: actor.userId,
      shared,
      metadata: { source: "manual-token" },
    });
    audit(actor, "provider_account.created", account);
    return c.json({ account: publicAccount(account, actor) }, 201);
  });

  app.patch("/v1/accounts/:accountId", async (c) => {
    const actor = principal(c);
    const account = getAccount(c.req.param("accountId"));
    if (account === undefined) return c.json({ error: "Account not found" }, 404);
    if (!principalCanManageAccount(actor, account)) return c.json({ error: "Forbidden" }, 403);
    const body = await readJsonObject(c);
    if (body["shared"] === true && (actor === undefined || !isAdmin(actor))) {
      return c.json({ error: "Only admins can share accounts" }, 403);
    }
    const updated = patchAccount(account.id, {
      label: optionalString(body["label"]),
      shared: typeof body["shared"] === "boolean" ? body["shared"] : undefined,
      status:
        body["status"] === "active" ||
        body["status"] === "disabled" ||
        body["status"] === "error"
          ? body["status"]
          : undefined,
    });
    audit(actor!, "provider_account.updated", account);
    return c.json({ account: publicAccount(updated!, actor) });
  });

  app.delete("/v1/accounts/:accountId", (c) => {
    const actor = principal(c);
    const account = getAccount(c.req.param("accountId"));
    if (account === undefined) return c.json({ error: "Account not found" }, 404);
    if (!principalCanManageAccount(actor, account)) return c.json({ error: "Forbidden" }, 403);
    deleteAccount(account.id);
    audit(actor!, "provider_account.deleted", account);
    return c.json({ success: true });
  });

  app.post("/v1/accounts/:accountId/refresh", async (c) => {
    const actor = principal(c);
    const account = getAccount(c.req.param("accountId"));
    if (account === undefined) return c.json({ error: "Account not found" }, 404);
    if (!principalCanManageAccount(actor, account)) return c.json({ error: "Forbidden" }, 403);
    try {
      const updated = await refreshAttachedAccount(account);
      return c.json({ account: publicAccount(updated, actor) });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  // Browser PKCE supports multiple simultaneous pending accounts. On a remote
  // deployment, paste the localhost callback URL into /complete.
  app.post("/v1/accounts/codex/oauth/start", async (c) => {
    const actor = principal(c)!;
    const body = await readJsonObject(c);
    const shared = body["shared"] === true;
    if (shared && !isAdmin(actor)) return c.json({ error: "Only admins can share accounts" }, 403);
    const flow = beginCodexBrowserFlow({
      ownerUserId: actor.userId,
      shared,
    });
    return c.json({
      flow: {
        id: flow.id,
        authorize_url: flow.authorizeUrl,
        expires_at: flow.expiresAt,
        callback_uri: "http://localhost:1455/auth/callback",
      },
    });
  });

  app.post("/v1/accounts/codex/oauth/complete", async (c) => {
    const actor = principal(c)!;
    const body = await readJsonObject(c);
    try {
      const account = await completeCodexBrowserFlow({
        code: optionalString(body["code"]),
        state: optionalString(body["state"]),
        callbackUrl: optionalString(body["callback_url"]),
      });
      if (!principalCanManageAccount(actor, account)) {
        deleteAccount(account.id);
        return c.json({ error: "OAuth flow belongs to a different user" }, 403);
      }
      audit(actor, "provider_account.created", account);
      return c.json({ account: publicAccount(account, actor) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/v1/accounts/codex/device/start", async (c) => {
    const actor = principal(c)!;
    const body = await readJsonObject(c);
    const shared = body["shared"] === true;
    if (shared && !isAdmin(actor)) return c.json({ error: "Only admins can share accounts" }, 403);
    try {
      pruneExpiredDeviceFlows();
      const flow = await beginCodexDeviceFlow({ ownerUserId: actor.userId, shared });
      codexDeviceFlows.set(flow.id, flow);
      return c.json({
        flow: {
          id: flow.id,
          user_code: flow.userCode,
          verification_url: flow.verificationUrl,
          interval_ms: flow.intervalMs,
          expires_at: flow.expiresAt,
        },
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  app.post("/v1/accounts/codex/device/:flowId/poll", async (c) => {
    const actor = principal(c)!;
    pruneExpiredDeviceFlows();
    const flow = codexDeviceFlows.get(c.req.param("flowId"));
    if (flow === undefined) return c.json({ error: "Device flow not found" }, 404);
    if (flow.ownerUserId !== actor.userId && !actor.ownerBypass) {
      return c.json({ error: "Forbidden" }, 403);
    }
    try {
      const account = await pollCodexDeviceFlow(flow, c.req.raw.signal);
      codexDeviceFlows.delete(flow.id);
      audit(actor, "provider_account.created", account);
      return c.json({ account: publicAccount(account, actor) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  app.post("/v1/accounts/codex/import-local", (c) => {
    const actor = principal(c)!;
    if (!isAdmin(actor)) return c.json({ error: "Only admins can import server credentials" }, 403);
    try {
      const account = importCodexAuthFile({ ownerUserId: actor.userId, shared: false });
      audit(actor, "provider_account.imported", account);
      return c.json({ account: publicAccount(account, actor) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.post("/v1/accounts/supergrok/device/start", async (c) => {
    const actor = principal(c)!;
    const body = await readJsonObject(c);
    const shared = body["shared"] === true;
    if (shared && !isAdmin(actor)) return c.json({ error: "Only admins can share accounts" }, 403);
    try {
      pruneExpiredDeviceFlows();
      const flow = await beginSuperGrokDeviceFlow({ ownerUserId: actor.userId, shared });
      superGrokDeviceFlows.set(flow.id, flow);
      return c.json({
        flow: {
          id: flow.id,
          user_code: flow.userCode,
          verification_url: flow.verificationUrl,
          interval_ms: flow.intervalMs,
          expires_at: flow.expiresAt,
        },
      });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  app.post("/v1/accounts/supergrok/device/:flowId/poll", async (c) => {
    const actor = principal(c)!;
    pruneExpiredDeviceFlows();
    const flow = superGrokDeviceFlows.get(c.req.param("flowId"));
    if (flow === undefined) return c.json({ error: "Device flow not found" }, 404);
    if (flow.ownerUserId !== actor.userId && !actor.ownerBypass) {
      return c.json({ error: "Forbidden" }, 403);
    }
    try {
      const account = await pollSuperGrokDeviceFlow(flow, c.req.raw.signal);
      superGrokDeviceFlows.delete(flow.id);
      audit(actor, "provider_account.created", account);
      return c.json({ account: publicAccount(account, actor) }, 201);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  return app;
}

function publicAccount(account: ProviderAccount, actor: Principal | undefined): Record<string, unknown> {
  return {
    id: account.id,
    provider: account.provider,
    kind: account.kind,
    label: account.label,
    email: account.email,
    account_id: account.accountId,
    plan: account.plan,
    owner_user_id: account.ownerUserId,
    shared: account.shared,
    status: account.status,
    last_error: account.lastError,
    last_used_at: account.lastUsedAt,
    last_refreshed_at: account.lastRefreshedAt,
    expires_at: account.expiresAt,
    created_at: account.createdAt,
    can_manage: principalCanManageAccount(actor, account),
    can_use: principalCanUseAccount(actor, account),
  };
}

function isAdmin(actor: Principal): boolean {
  return actor.ownerBypass || actor.role === "owner" || actor.role === "admin";
}

function audit(actor: Principal, type: string, account: ProviderAccount): void {
  recordAuditEvent({
    actorUserId: actor.userId,
    eventType: type,
    targetType: "provider_account",
    targetId: account.id,
    details: { provider: account.provider, shared: account.shared },
  });
}


function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

