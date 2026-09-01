import { readJsonObject } from "../read-json-object.ts";
import { isSameOriginMutation } from "../same-origin.ts";
import { matchesLogFilters } from "../../shared/log-filters.ts";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

import {
  deleteModelConfig,
  getRawModelConfig,
  listModelConfigs,
  patchModelConfig,
  writeModelConfig,
} from "../../config/model-writer.ts";
import {
  deleteProviderConfig,
  getRawProviderConfig,
  listProviderConfigs,
  patchProviderConfig,
  writeProviderConfig,
} from "../../config/provider-writer.ts";
import { listConfigEntries, replaceConfigValues } from "../../config/config-store.ts";
import { getWritableConfigDir } from "../../config/paths.ts";
import {
  currentProxyStatus,
  discoverProxies,
  type ProxyDiscoveryProgress,
  type ProxyDiscoveryReport,
} from "../../providers/proxy-discovery.ts";
import { exportBundle } from "../../config/bundle-exporter.ts";
import {
  applyBundle,
  parseBundle,
  previewBundle,
} from "../../config/bundle-importer.ts";
import type { ImportOptions } from "@model-proxy/contracts/schemas/config-bundle.ts";
import { eventSink } from "../../observability/event-sink.ts";
import { createLogger } from "../../observability/logger.ts";
import { calculateCosts, resolvePricing } from "../../observability/pricing.ts";
import type { UsageSnapshot } from "../../observability/usage.ts";
import { getAnalyticsSummary, getAnalyticsTimeseries } from "../../storage/analytics-store.ts";
import { readCompletionEnvelope } from "../../storage/completion-store.ts";
import {
  createSession,
  createUser,
  createUserApiKey,
  consumeInvite,
  createInvite,
  ensureSystemOwnerUser,
  isInviteUsable,
  listUserApiKeys,
  listInvites,
  listUsers,
  ownerUserExists,
  recordAuditEvent,
  readSignupSettings,
  revokeSessionToken,
  deleteUserApiKey,
  verifyEmailPassword,
  writeSignupSettings,
} from "../../storage/identity-store.ts";
import {
  readAnalyticsPricingSettings,
  writeAnalyticsPricingSettings,
  type AnalyticsPricingSettings,
} from "../../storage/pricing-store.ts";
import type { RequestLogFilters } from "../../storage/types.ts";
import {
  getUserLimits,
  setUserLimits,
  type UserLimits,
} from "../../storage/limit-store.ts";
import {
  listUserEntitlements,
  setUserEntitlements,
  type EntitlementResourceType,
} from "../../storage/policy-store.ts";
import { activeRequestCount, activeRequestCountForUser, recentRequestLogs } from "../request-log.ts";
import {
  authenticateRequest,
  isAuthConfigured,
  isSessionValid,
  requireAuth,
  SESSION_COOKIE,
  principal,
  verifyApiKeyString,
  verifyClientApiKey,
} from "../auth.ts";

const log = createLogger("routes.admin");

const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

function filtersFromQuery(query: (name: string) => string | undefined): RequestLogFilters {
  const filters: RequestLogFilters = {};
  const provider = query("provider");
  const model = query("model");
  const apiKeyEnvVar = query("api_key_env") ?? query("apiKeyEnvVar");
  const status = query("status");
  const state = query("state");
  const cacheHit = query("cache_hit") ?? query("cacheHit");
  const since = query("since");
  const until = query("until");
  const search = query("search");
  if (provider !== undefined && provider !== "") filters.provider = provider;
  if (model !== undefined && model !== "") filters.model = model;
  if (apiKeyEnvVar !== undefined && apiKeyEnvVar !== "") filters.apiKeyEnvVar = apiKeyEnvVar;
  if (status === "ok" || status === "error" || status === "running") filters.status = status;
  if (state === "running" || state === "completed") filters.state = state;
  if (cacheHit === "true") filters.cacheHit = true;
  if (cacheHit === "false") filters.cacheHit = false;
  if (since !== undefined && since !== "") filters.since = since;
  if (until !== undefined && until !== "") filters.until = until;
  if (search !== undefined && search !== "") filters.search = search;
  return filters;
}

function logsRange(query: (name: string) => string | undefined): { limit: number; offset: number } {
  const limit = Number.parseInt(query("limit") ?? "", 10);
  const offset = Number.parseInt(query("offset") ?? "", 10);
  return {
    limit: Number.isFinite(limit) && limit > 0 ? limit : 100,
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  };
}


function logWithDerivedCosts(
  row: ReturnType<typeof recentRequestLogs>[number],
): ReturnType<typeof recentRequestLogs>[number] {
  if (
    row.userCostUsd !== 0 ||
    row.typicalCostUsd !== 0 ||
    row.savedCostUsd !== 0 ||
    (row.totalTokens ?? 0) <= 0
  ) {
    return row;
  }
  const costs = calculateCosts(logUsage(row), resolvePricing({
    requestedModel: row.requestedModel,
    resolvedProvider: row.resolvedProvider,
    resolvedModel: row.resolvedModel,
    apiKeyEnvVar: row.apiKeyEnvVar,
  }));
  return {
    ...row,
    userCostUsd: costs.userCostUsd,
    typicalCostUsd: costs.typicalCostUsd,
    savedCostUsd: costs.savedCostUsd,
  };
}

function logsPayload({
  filters,
  activeCount,
  limit,
  offset,
}: {
  filters: RequestLogFilters;
  activeCount: number;
  limit: number;
  offset: number;
}) {
  const filtered = recentRequestLogs(Number.MAX_SAFE_INTEGER, 0)
    .filter((record) => matchesLogFilters(record, filters));
  const records = filtered.slice(offset, offset + limit).map(logWithDerivedCosts);
  return {
    count: records.length,
    limit,
    offset,
    total: filtered.length,
    total_completed: filtered.filter((record) => record.state === "completed").length,
    total_in_buffer: filtered.length,
    active_count: activeCount,
    has_more: offset + records.length < filtered.length,
    filters_applied: filters,
    records,
  };
}

function logUsage(row: ReturnType<typeof recentRequestLogs>[number]): UsageSnapshot {
  return {
    promptTokens: row.promptTokens,
    promptTokensEstimated: row.promptTokensEstimated ?? false,
    completionTokens: row.completionTokens,
    completionTokensEstimated: row.completionTokensEstimated ?? false,
    totalTokens: row.totalTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheCreationTokens: row.cacheCreationTokens,
    cachedTokens: row.cachedTokens,
  };
}

export function createAdminRoutes(): Hono {
  const app = new Hono();

  // -- First-run setup status (public; drives the onboarding flow) -----------

  app.get("/v1/admin/setup/status", (c) => {
    const models = listModelConfigs().length;
    const providers = listProviderConfigs().length;
    return c.json({
      needs_setup: models === 0,
      models_count: models,
      providers_count: providers,
    });
  });

  // -- Auth routes (public — they ESTABLISH the session) ---------------------

  app.get("/v1/auth/status", (c) => {
    if (!isAuthConfigured()) {
      return c.json({
        authenticated: true,
        reason: "no-auth-configured",
        header_authenticated: true,
        session_authenticated: true,
      });
    }
    const headerAuthenticated = verifyClientApiKey(c);
    const sessionAuthenticated = isSessionValid(c);
    if (headerAuthenticated || sessionAuthenticated) {
      return c.json({
        authenticated: true,
        header_authenticated: headerAuthenticated,
        session_authenticated: sessionAuthenticated,
      });
    }
    return c.json(
      {
        authenticated: false,
        header_authenticated: false,
        session_authenticated: false,
      },
      401,
    );
  });

  app.post("/v1/auth/signup", async (c) => {
    const body = await readJsonObject(c);
    const email = typeof body["email"] === "string" ? body["email"].trim() : "";
    const password = typeof body["password"] === "string" ? body["password"] : "";
    const inviteToken = typeof body["invite_token"] === "string" ? body["invite_token"].trim() : "";
    if (!isValidSignupInput(email, password)) {
      return c.json({ error: "Email and password are required; password must be at least 8 characters." }, 400);
    }

    const usingInvite = inviteToken.length > 0;
    const settings = readSignupSettings();
    const bootstrappingOwner = !ownerUserExists() && !usingInvite;
    if (usingInvite && !isInviteUsable(inviteToken, email)) {
      return c.json({ error: "Signup requires a valid invite." }, 403);
    }
    if (!bootstrappingOwner && !settings.openSignupEnabled) {
      if (!settings.inviteSignupEnabled || !usingInvite) {
        return c.json({ error: "Signup requires a valid invite." }, 403);
      }
    }
    if (bootstrappingOwner && !usingInvite && isAuthConfigured() && !verifyClientApiKey(c)) {
      // The admin key can also be presented via an established owner session
      // (the UI logs in with the key first and never stores it afterwards).
      const actor = authenticateRequest(c, { allowSession: true });
      if (actor === undefined || !actor.isOwner) {
        return c.json({ error: "Owner bootstrap requires the admin API key." }, 401);
      }
    }

    try {
      const user = createUser({
        email,
        password,
        role: bootstrappingOwner ? "owner" : "user",
        completionLoggingEnabled: false,
      });
      const invite = usingInvite ? consumeInvite(inviteToken, user.id, email) : undefined;
      if (usingInvite && invite === undefined) return c.json({ error: "Invite could not be consumed." }, 409);
      if (invite) {
        const inviteLimits = invite.limits;
        if (inviteLimits && Object.keys(inviteLimits).length > 0) {
          setUserLimits(user.id, limitsFromBody(inviteLimits));
        }
        const modelAccess = listModelConfigs().map((model) => model.logical_name);
        const entitlements = modelAccess.flatMap((model) => [
          { resourceType: "model" as EntitlementResourceType, resourceId: model, allowed: true },
          { resourceType: "fusion_model" as EntitlementResourceType, resourceId: model, allowed: true },
        ]);
        setUserEntitlements(user.id, entitlements);
      }
      const session = createSession(user.id);
      setSessionCookie(c, session.token);
      return c.json({ user, invite, bootstrap_owner: bootstrappingOwner }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // One login endpoint: accepts the admin API key ({ api_key }) or account
  // credentials ({ email, password }). Both establish the same DB-backed
  // session cookie.
  app.post("/v1/auth/login", async (c) => {
    const body = await readJsonObject(c);
    const apiKey = typeof body["api_key"] === "string" ? body["api_key"] : "";
    const email = typeof body["email"] === "string" ? body["email"] : "";
    const password = typeof body["password"] === "string" ? body["password"] : "";

    if (apiKey.length > 0 || (email.length === 0 && password.length === 0)) {
      // Admin-key login (explicit body key, or Authorization header fallback).
      const keyOk = apiKey.length > 0 ? verifyApiKeyString(apiKey) : verifyClientApiKey(c);
      if (!keyOk) return c.json({ authenticated: false }, 401);
      if (!isAuthConfigured()) {
        return c.json({ authenticated: true, reason: "no-auth-configured" });
      }
      const owner = ensureSystemOwnerUser();
      const session = createSession(owner.id);
      setSessionCookie(c, session.token);
      return c.json({ authenticated: true });
    }

    const user = verifyEmailPassword(email, password);
    if (user === undefined) return c.json({ authenticated: false }, 401);
    const session = createSession(user.id);
    setSessionCookie(c, session.token);
    return c.json({ authenticated: true, user });
  });

  app.post("/v1/auth/logout", (c) => {
    revokeSessionToken(getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ success: true });
  });

  app.get("/v1/auth/me", requireAuth({ allowSession: true }), (c) => {
    const p = principal(c);
    return c.json({
      principal: p,
      signup: readSignupSettings(),
      owner_user_exists: ownerUserExists(),
    });
  });

  // -- Protected routes go into their own sub-Hono with gate middleware -----
  // The middleware is scoped to admin paths only so that mounting this router
  // at "/" does not accidentally gate the static UI or inference endpoints.
  const protectedApp = new Hono();
  const gate: Parameters<Hono["use"]>[1] = async (c, next) => {
    if (!isSameOriginMutation(c)) return c.json({ error: "Cross-origin mutation denied" }, 403);
    return requireAuth({ allowSession: true })(c, next);
  };
  protectedApp.use("/v1/admin/logs", gate);
  protectedApp.use("/v1/admin/analytics", gate);
  protectedApp.use("/v1/admin/analytics/*", gate);
  protectedApp.use("/v1/admin/storage/*", gate);
  protectedApp.use("/v1/admin/config/*", gate);
  protectedApp.use("/v1/admin/events/*", gate);
  protectedApp.use("/v1/admin/proxies", gate);
  protectedApp.use("/v1/admin/proxies/*", gate);
  protectedApp.use("/v1/admin/users", gate);
  protectedApp.use("/v1/admin/users/*", gate);
  protectedApp.use("/v1/admin/invites", gate);
  protectedApp.use("/v1/admin/invites/*", gate);
  protectedApp.use("/v1/admin/signup-settings", gate);
  protectedApp.use("/v1/user/*", gate);

  protectedApp.get("/v1/admin/users", (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    return c.json({ users: listUsers() });
  });

  protectedApp.get("/v1/admin/users/:userId/entitlements", (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    return c.json({ entitlements: listUserEntitlements(c.req.param("userId")) });
  });

  protectedApp.put("/v1/admin/users/:userId/entitlements", async (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    const body = await readJsonObject(c);
    const entries = Array.isArray(body["entitlements"]) ? body["entitlements"] : [];
    const entitlements = entries.flatMap((entry): Array<{
      resourceType: EntitlementResourceType;
      resourceId: string;
      allowed?: boolean;
    }> => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const obj = entry as Record<string, unknown>;
      const resourceType = obj["resource_type"];
      const resourceId = obj["resource_id"];
      if (!isEntitlementResourceType(resourceType) || typeof resourceId !== "string") return [];
      return [{ resourceType, resourceId, allowed: booleanField(obj["allowed"]) }];
    });
    const userId = c.req.param("userId");
    const saved = setUserEntitlements(userId, entitlements);
    recordAuditEvent({
      actorUserId: p.userId,
      eventType: "user.entitlements.updated",
      targetType: "user",
      targetId: userId,
      details: { count: saved.length },
    });
    return c.json({ entitlements: saved });
  });

  protectedApp.get("/v1/admin/users/:userId/limits", (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    return c.json({ limits: getUserLimits(c.req.param("userId")) });
  });

  protectedApp.put("/v1/admin/users/:userId/limits", async (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    const body = await readJsonObject(c);
    const userId = c.req.param("userId");
    const limits = setUserLimits(userId, limitsFromBody(body));
    recordAuditEvent({
      actorUserId: p.userId,
      eventType: "user.limits.updated",
      targetType: "user",
      targetId: userId,
      details: { ...limits },
    });
    return c.json({ limits });
  });

  protectedApp.get("/v1/admin/invites", (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    return c.json({ invites: listInvites() });
  });

  protectedApp.post("/v1/admin/invites", async (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    const body = await readJsonObject(c);
    const expiresAt = typeof body["expires_at"] === "string" ? body["expires_at"] : undefined;
    const email = typeof body["email"] === "string" ? body["email"] : undefined;
    const invite = createInvite({
      email,
      expiresAt,
      createdByUserId: p.userId,
      limits: objectField(body["limits"]),
      accessProfileId:
        typeof body["access_profile_id"] === "string"
          ? body["access_profile_id"]
          : undefined,
    });
    recordAuditEvent({
      actorUserId: p.userId,
      eventType: "invite.created",
      targetType: "invite",
      targetId: invite.invite.id,
      details: { email: invite.invite.email },
    });
    return c.json(invite, 201);
  });

  protectedApp.get("/v1/admin/signup-settings", (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    return c.json({ signup: readSignupSettings() });
  });

  protectedApp.put("/v1/admin/signup-settings", async (c) => {
    const p = principal(c);
    if (p === undefined || (!p.isOwner && p.role !== "admin")) return c.json({ error: "Forbidden" }, 403);
    const body = await readJsonObject(c);
    const signup = writeSignupSettings({
        multiUserEnabled: booleanField(body["multi_user_enabled"]),
        openSignupEnabled: booleanField(body["open_signup_enabled"]),
        inviteSignupEnabled: booleanField(body["invite_signup_enabled"]),
        allowUserKeyCreation: booleanField(body["allow_user_key_creation"]),
        allowUserCompletionLogging: booleanField(body["allow_user_completion_logging"]),
        defaultAccessProfileId:
          typeof body["default_access_profile_id"] === "string"
            ? body["default_access_profile_id"]
            : undefined,
        defaultLimits: objectField(body["default_limits"]),
        inviteLimits: objectField(body["invite_limits"]),
      });
    recordAuditEvent({
      actorUserId: p.userId,
      eventType: "signup.settings.updated",
      targetType: "signup_settings",
      targetId: "1",
      details: { ...signup },
    });
    return c.json({
      signup,
    });
  });

  protectedApp.get("/v1/user/api-keys", (c) => {
    const p = principal(c);
    if (p?.userId === undefined) return c.json({ keys: [] });
    return c.json({ keys: listUserApiKeys(p.userId) });
  });

  protectedApp.get("/v1/user/limits", (c) => {
    const p = principal(c);
    if (p?.userId === undefined) return c.json({ error: "A persisted user account is required." }, 400);
    return c.json({ limits: getUserLimits(p.userId) });
  });

  protectedApp.get("/v1/user/analytics", async (c) => {
    const p = principal(c);
    if (p?.userId === undefined) return c.json({ error: "A persisted user account is required." }, 400);
    const filters: RequestLogFilters = { ...filtersFromQuery((name) => c.req.query(name)), userId: p.userId };
    await new Promise((resolve) => setTimeout(resolve, 0));
    return c.json({
      filters_applied: filters,
      summary: getAnalyticsSummary(filters, activeRequestCountForUser(p.userId)),
    });
  });

  protectedApp.get("/v1/user/analytics/timeseries", async (c) => {
    const p = principal(c);
    if (p?.userId === undefined) return c.json({ error: "A persisted user account is required." }, 400);
    const filters: RequestLogFilters = { ...filtersFromQuery((name) => c.req.query(name)), userId: p.userId };
    const bucket = c.req.query("bucket") === "day" ? "day" : "hour";
    await new Promise((resolve) => setTimeout(resolve, 0));
    return c.json({
      bucket,
      filters_applied: filters,
      points: getAnalyticsTimeseries(filters, bucket),
    });
  });

  protectedApp.get("/v1/user/logs", (c) => {
    const p = principal(c);
    if (p?.userId === undefined) return c.json({ error: "A persisted user account is required." }, 400);
    const { limit, offset } = logsRange((name) => c.req.query(name));
    const filters: RequestLogFilters = { ...filtersFromQuery((name) => c.req.query(name)), userId: p.userId };
    return c.json(logsPayload({ filters, activeCount: activeRequestCountForUser(p.userId), limit, offset }));
  });

  protectedApp.post("/v1/user/api-keys", async (c) => {
    const p = principal(c);
    if (p?.userId === undefined) return c.json({ error: "A persisted user account is required." }, 400);
    const settings = readSignupSettings();
    if (!p.isOwner && !settings.allowUserKeyCreation) return c.json({ error: "API key creation is disabled." }, 403);
    const body = await readJsonObject(c);
    const label = typeof body["label"] === "string" ? body["label"] : undefined;
    return c.json({ api_key: createUserApiKey({ userId: p.userId, label }) }, 201);
  });

  protectedApp.delete("/v1/user/api-keys/:id", (c) => {
    const p = principal(c);
    if (p?.userId === undefined) return c.json({ error: "A persisted user account is required." }, 400);
    const keyId = c.req.param("id");
    if (!deleteUserApiKey(p.userId, keyId)) return c.json({ error: "API key not found" }, 404);
    recordAuditEvent({
      actorUserId: p.userId,
      eventType: "api_key.deleted",
      targetType: "api_key",
      targetId: keyId,
    });
    return c.json({ deleted: true });
  });

  protectedApp.get("/v1/admin/logs", (c) => {
    const { limit, offset } = logsRange((name) => c.req.query(name));
    const filters = filtersFromQuery((name) => c.req.query(name));
    return c.json(logsPayload({ filters, activeCount: activeRequestCount(), limit, offset }));
  });

  protectedApp.get("/v1/admin/analytics", async (c) => {
    const filters = filtersFromQuery((name) => c.req.query(name));
    await new Promise((resolve) => setTimeout(resolve, 0));
    return c.json({
      filters_applied: filters,
      summary: getAnalyticsSummary(filters, activeRequestCount()),
    });
  });

  protectedApp.get("/v1/admin/analytics/timeseries", async (c) => {
    const filters = filtersFromQuery((name) => c.req.query(name));
    const bucket = c.req.query("bucket") === "day" ? "day" : "hour";
    await new Promise((resolve) => setTimeout(resolve, 0));
    return c.json({
      bucket,
      filters_applied: filters,
      points: getAnalyticsTimeseries(filters, bucket),
    });
  });

  protectedApp.get("/v1/admin/analytics/pricing", (c) => {
    return c.json({ pricing: readAnalyticsPricingSettings() });
  });

  protectedApp.put("/v1/admin/analytics/pricing", async (c) => {
    const body = (await c.req.json()) as AnalyticsPricingSettings;
    return c.json({ pricing: writeAnalyticsPricingSettings(body) });
  });

  protectedApp.get("/v1/admin/storage/completions/:requestId", (c) => {
    const envelope = readCompletionEnvelope(c.req.param("requestId"));
    if (envelope === undefined) return c.json({ error: "Unknown requestId" }, 404);
    return c.json({ completion: envelope });
  });

  // -- Per-request event traces ---------------------------------------------

  protectedApp.get("/v1/admin/events/:requestId", (c) => {
    const id = c.req.param("requestId");
    const trace = eventSink.get(id);
    if (trace === undefined) {
      return c.json({ error: "Unknown requestId" }, 404);
    }
    return c.json({
      requestId: trace.requestId,
      finished: trace.finished,
      startedAt: new Date(trace.startedAt).toISOString(),
      events: trace.events,
    });
  });

  protectedApp.get("/v1/admin/events/:requestId/stream", (c) => {
    const id = c.req.param("requestId");
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const safeEnqueue = (frame: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(frame));
          } catch {
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        // 1. Send any backlog immediately so clients joining mid-flight see history.
        const existing = eventSink.get(id);
        const backlog = existing?.events ?? [];
        const alreadyFinished = existing?.finished ?? false;
        for (const event of backlog) {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
        }

        if (alreadyFinished) {
          close();
          return;
        }

        // 2. Subscribe for live events. `subscribe` creates a placeholder
        //    trace if unknown, so SSE can open BEFORE the POST arrives.
        const unsubscribe = eventSink.subscribe(id, (event) => {
          safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
          if (event.type === "request.finished") {
            unsubscribe();
            close();
          }
        });

        // 3. Keep-alive heartbeat so proxies don't kill idle connections.
        safeEnqueue(`: keepalive ${Date.now()}\n\n`);
        const heartbeat = setInterval(() => {
          safeEnqueue(`: keepalive ${Date.now()}\n\n`);
        }, 15000);

        // 4. Client disconnect — clean up promptly.
        const onAbort = () => {
          clearInterval(heartbeat);
          unsubscribe();
          close();
        };
        const signal = c.req.raw.signal;
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  });


  // -- Proxy discovery / status ----------------------------------------------

  let lastProxyDiscovery: ProxyDiscoveryReport | undefined;
  interface ProxyDiscoveryJobSnapshot {
    id: string;
    status: "running" | "completed" | "failed";
    startedAt: string;
    finishedAt?: string;
    error?: string;
    progress?: ProxyDiscoveryProgress;
    report?: ProxyDiscoveryReport;
  }
  let proxyDiscoveryJob: ProxyDiscoveryJobSnapshot | undefined;

  protectedApp.get("/v1/admin/proxies", (c) => {
    const providersParam = c.req.query("providers");
    const providers = providersParam !== undefined && providersParam.length > 0
      ? providersParam.split(",").map((p) => p.trim()).filter((p) => p.length > 0)
      : undefined;
    return c.json({
      status: currentProxyStatus(providers),
      last_discovery: lastProxyDiscovery,
      discovery_job: proxyDiscoveryJob,
    });
  });

  protectedApp.post("/v1/admin/proxies/discover", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      target_count?: number;
      providers?: string[];
      persist?: boolean;
      timeout_ms?: number;
      concurrency?: number;
      source_limit?: number;
      sources?: string[];
      candidates?: string[];
    };
    if (proxyDiscoveryJob?.status === "running") {
      return c.json({ job: proxyDiscoveryJob }, 202);
    }
    try {
      const job: ProxyDiscoveryJobSnapshot = {
        id: crypto.randomUUID(),
        status: "running",
        startedAt: new Date().toISOString(),
      };
      proxyDiscoveryJob = job;
      void discoverProxies({
        targetCount: body.target_count,
        providers: body.providers,
        persist: body.persist,
        timeoutMs: body.timeout_ms,
        concurrency: body.concurrency,
        sourceLimit: body.source_limit,
        sources: body.sources,
        candidates: body.candidates,
        onProgress: (progress) => {
          if (proxyDiscoveryJob?.id === job.id && proxyDiscoveryJob.status === "running") {
            proxyDiscoveryJob = { ...proxyDiscoveryJob, progress };
          }
        },
      })
        .then((report) => {
          lastProxyDiscovery = report;
          proxyDiscoveryJob = {
            ...job,
            status: "completed",
            finishedAt: new Date().toISOString(),
            report,
          };
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          log.error("proxy discovery failed", { err: message });
          proxyDiscoveryJob = {
            ...job,
            status: "failed",
            finishedAt: new Date().toISOString(),
            error: message,
          };
        });
      return c.json({ job }, 202);
    } catch (err) {
      log.error("proxy discovery failed", { err: (err as Error).message });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // -- Model config CRUD ------------------------------------------------------

  protectedApp.get("/v1/admin/config/models", (c) => {
    return c.json({ models: listModelConfigs() });
  });

  protectedApp.get("/v1/admin/config/models/:name", (c) => {
    const name = c.req.param("name");
    try {
      return c.json({ model: getRawModelConfig(name) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  protectedApp.post("/v1/admin/config/models/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeModelConfig(name, body, { overwrite: false });
      return c.json({ model: config }, 201);
    } catch (err) {
      log.warn("create model failed", { name, err: String(err) });
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.put("/v1/admin/config/models/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeModelConfig(name, body, { overwrite: true });
      return c.json({ model: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.patch("/v1/admin/config/models/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = patchModelConfig(name, body as Record<string, unknown>);
      return c.json({ model: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.delete("/v1/admin/config/models/:name", (c) => {
    const name = c.req.param("name");
    const ok = deleteModelConfig(name);
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true, name });
  });

  // -- Provider config CRUD ---------------------------------------------------

  protectedApp.get("/v1/admin/config/providers", (c) => {
    return c.json({ providers: listProviderConfigs() });
  });

  protectedApp.get("/v1/admin/config/providers/:name", (c) => {
    const name = c.req.param("name");
    try {
      return c.json({ provider: getRawProviderConfig(name) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404);
    }
  });

  protectedApp.post("/v1/admin/config/providers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeProviderConfig(name, body, { overwrite: false });
      return c.json({ provider: config }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.put("/v1/admin/config/providers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = writeProviderConfig(name, body, { overwrite: true });
      return c.json({ provider: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.patch("/v1/admin/config/providers/:name", async (c) => {
    const name = c.req.param("name");
    const body = await c.req.json();
    try {
      const config = patchProviderConfig(name, body as Record<string, unknown>);
      return c.json({ provider: config });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  protectedApp.delete("/v1/admin/config/providers/:name", (c) => {
    const name = c.req.param("name");
    const ok = deleteProviderConfig(name);
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ deleted: true, name });
  });

  // -- Runtime settings + secrets (UI-managed config store) -------------------

  protectedApp.get("/v1/admin/config/env", (c) => {
    const revealParam = c.req.query("reveal");
    const reveal = revealParam === "true" || revealParam === "1";
    const entries = listConfigEntries({ includeValues: reveal });
    return c.json({
      path: getWritableConfigDir(),
      reveal,
      entries,
    });
  });

  protectedApp.put("/v1/admin/config/env", async (c) => {
    const body = (await c.req.json()) as {
      entries?: Array<{ key: string; value: string }>;
    };
    if (!Array.isArray(body.entries)) {
      return c.json({ error: "Request body must contain an 'entries' array" }, 400);
    }
    const result = replaceConfigValues(body.entries);
    return c.json({
      path: getWritableConfigDir(),
      applied: result.applied,
      skipped: result.skipped,
    });
  });

  // -- Full configuration bundle (import / export) --------------------------

  protectedApp.get("/v1/admin/config/export", () => {
    const bundle = exportBundle();
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `model-proxy-config-${stamp}.json`;
    return new Response(JSON.stringify(bundle, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  });

  protectedApp.post("/v1/admin/config/import", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch (err) {
      return c.json(
        { error: `Request body must be valid JSON: ${(err as Error).message}` },
        400,
      );
    }

    const envelope = (body ?? {}) as {
      bundle?: unknown;
      options?: ImportOptions;
    };
    const bundleRaw = envelope.bundle ?? body; // accept either { bundle, options } or a bare bundle.
    const opts = envelope.options;

    let bundle;
    try {
      bundle = parseBundle(bundleRaw);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }

    const dryRunParam = c.req.query("dry_run");
    const dryRun = dryRunParam === "true" || dryRunParam === "1";

    try {
      if (dryRun) {
        const diff = previewBundle(bundle, opts);
        return c.json({ dry_run: true, ...diff });
      }
      const report = applyBundle(bundle, opts);
      return c.json({ dry_run: false, ...report });
    } catch (err) {
      log.error("bundle import failed", {
        err: (err as Error).message,
      });
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.route("/", protectedApp);
  return app;
}

function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    maxAge: SESSION_MAX_AGE,
  });
}


function isValidSignupInput(email: string, password: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) && password.length >= 8;
}

function objectField(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isEntitlementResourceType(value: unknown): value is EntitlementResourceType {
  return value === "model" || value === "audio_model" || value === "route" || value === "fusion_model";
}

function limitsFromBody(body: Record<string, unknown>): UserLimits {
  return {
    requestsPerMinute: numberField(body["requests_per_minute"]),
    requestsPerDay: numberField(body["requests_per_day"]),
    tokensPerDay: numberField(body["tokens_per_day"]),
    costUsdPerDay: numberField(body["cost_usd_per_day"]),
    concurrentRequests: numberField(body["concurrent_requests"]),
  };
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}



