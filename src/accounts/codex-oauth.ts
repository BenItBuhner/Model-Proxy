import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../observability/logger.ts";
import {
  createAccount,
  updateAccountTokens,
  type ProviderAccount,
} from "../storage/account-store.ts";

const log = createLogger("accounts.codex-oauth");

export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_OAUTH_DEFAULT_ISSUER = "https://auth.openai.com";
export const CODEX_OAUTH_SCOPE = "openid profile email offline_access";
export const CODEX_OAUTH_REDIRECT_PORT = 1455;
export const CODEX_OAUTH_REDIRECT_PATH = "/auth/callback";
export const CODEX_OAUTH_REDIRECT_URI =
  `http://localhost:${CODEX_OAUTH_REDIRECT_PORT}${CODEX_OAUTH_REDIRECT_PATH}`;

const CODEX_AUTH_CLAIM = "https://api.openai.com/auth";
const FLOW_TTL_MS = 15 * 60 * 1000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

export interface CodexTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export interface CodexTokenClaims {
  sub?: string;
  email?: string;
  chatgpt_account_id?: string;
  chatgpt_plan_type?: string;
  organizations?: Array<{ id?: string }>;
  [CODEX_AUTH_CLAIM]?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
}

export interface CodexAccountIdentity {
  email: string | undefined;
  accountId: string | undefined;
  plan: string | undefined;
  subject: string | undefined;
}

export interface PendingCodexFlow {
  id: string;
  state: string;
  authorizeUrl: string;
  ownerUserId: string | undefined;
  shared: boolean;
  createdAt: string;
  expiresAt: string;
}

interface InternalPendingFlow extends PendingCodexFlow {
  verifier: string;
  issuer: string;
}

export interface CodexDeviceFlow {
  id: string;
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  ownerUserId: string | undefined;
  shared: boolean;
  createdAt: string;
  expiresAt: string;
}

const pendingFlows = new Map<string, InternalPendingFlow>();
let callbackServer: ReturnType<typeof Bun.serve> | undefined;

export function codexOAuthIssuer(): string {
  return (process.env["CODEX_OAUTH_ISSUER"] ?? CODEX_OAUTH_DEFAULT_ISSUER)
    .trim()
    .replace(/\/+$/, "");
}

function codexClientId(): string {
  return (process.env["CODEX_OAUTH_CLIENT_ID"] ?? CODEX_OAUTH_CLIENT_ID).trim();
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function parseJwtClaims(token: string): CodexTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as CodexTokenClaims)
      : undefined;
  } catch {
    return undefined;
  }
}

export function identityFromTokens(tokens: CodexTokenResponse): CodexAccountIdentity {
  const claims =
    (tokens.id_token !== undefined ? parseJwtClaims(tokens.id_token) : undefined) ??
    parseJwtClaims(tokens.access_token);
  const auth = claims?.[CODEX_AUTH_CLAIM];
  return {
    email: claims?.email,
    accountId:
      claims?.chatgpt_account_id ??
      auth?.chatgpt_account_id ??
      claims?.organizations?.[0]?.id,
    plan: claims?.chatgpt_plan_type ?? auth?.chatgpt_plan_type,
    subject: claims?.sub,
  };
}

export function buildAuthorizeUrl(options: {
  challenge: string;
  state: string;
  issuer?: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: codexClientId(),
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_SCOPE,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state: options.state,
    originator: "codex_cli_rs",
  });
  return `${options.issuer ?? codexOAuthIssuer()}/oauth/authorize?${params.toString()}`;
}

/**
 * Starts one browser PKCE flow. Multiple flows may remain pending at once:
 * every state has an independent verifier and account owner.
 */
export function beginCodexBrowserFlow(input: {
  ownerUserId?: string;
  shared?: boolean;
  startCallbackServer?: boolean;
} = {}): PendingCodexFlow {
  pruneExpiredFlows();
  const pkce = generatePkce();
  const state = randomBytes(32).toString("base64url");
  const id = randomBytes(18).toString("base64url");
  const now = new Date();
  const issuer = codexOAuthIssuer();
  const flow: InternalPendingFlow = {
    id,
    state,
    verifier: pkce.verifier,
    authorizeUrl: buildAuthorizeUrl({ challenge: pkce.challenge, state, issuer }),
    ownerUserId: input.ownerUserId,
    shared: input.shared === true,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
    issuer,
  };
  pendingFlows.set(state, flow);
  if (input.startCallbackServer !== false) ensureCodexCallbackServer();
  return publicFlow(flow);
}

/**
 * Completes a PKCE flow from either an authorization code or the full
 * localhost callback URL. The callback-URL form is important for remote
 * production deployments: the browser can copy the localhost URL to the
 * hosted admin UI when port 1455 is not reachable on the server.
 */
export async function completeCodexBrowserFlow(input: {
  code?: string;
  state?: string;
  callbackUrl?: string;
}): Promise<ProviderAccount> {
  let code = input.code;
  let state = input.state;
  if (input.callbackUrl !== undefined) {
    const callback = new URL(input.callbackUrl);
    code = callback.searchParams.get("code") ?? undefined;
    state = callback.searchParams.get("state") ?? undefined;
    const oauthError = callback.searchParams.get("error");
    if (oauthError !== null) {
      throw new Error(callback.searchParams.get("error_description") ?? oauthError);
    }
  }
  if (code === undefined || code.length === 0 || state === undefined || state.length === 0) {
    throw new Error("OAuth callback must contain both code and state");
  }
  const flow = pendingFlows.get(state);
  if (flow === undefined) throw new Error("OAuth state is invalid or has expired");
  pendingFlows.delete(state);
  if (Date.parse(flow.expiresAt) <= Date.now()) throw new Error("OAuth flow has expired");
  const tokens = await exchangeCodexCode({
    code,
    verifier: flow.verifier,
    issuer: flow.issuer,
  });
  return createCodexAccountFromTokens(tokens, {
    ownerUserId: flow.ownerUserId,
    shared: flow.shared,
  });
}

export async function exchangeCodexCode(input: {
  code: string;
  verifier: string;
  issuer?: string;
  redirectUri?: string;
}): Promise<CodexTokenResponse> {
  return tokenRequest(input.issuer ?? codexOAuthIssuer(), {
    grant_type: "authorization_code",
    client_id: codexClientId(),
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri ?? CODEX_OAUTH_REDIRECT_URI,
  });
}

export async function refreshCodexTokens(
  refreshToken: string,
  issuer = codexOAuthIssuer(),
): Promise<CodexTokenResponse> {
  return tokenRequest(issuer, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: codexClientId(),
  });
}

export async function refreshCodexAccount(account: ProviderAccount): Promise<ProviderAccount> {
  if (account.refreshToken === undefined || account.refreshToken.length === 0) {
    throw new Error("Codex account has no refresh token");
  }
  const tokens = await refreshCodexTokens(account.refreshToken);
  const updated = updateAccountTokens(account.id, tokenUpdate(tokens));
  if (updated === undefined) throw new Error("Codex account was deleted while refreshing");
  return updated;
}

export function createCodexAccountFromTokens(
  tokens: CodexTokenResponse,
  input: { ownerUserId?: string; shared?: boolean; label?: string } = {},
): ProviderAccount {
  const identity = identityFromTokens(tokens);
  return createAccount({
    provider: "codex",
    kind: "oauth",
    label: input.label ?? identity.email ?? "ChatGPT subscription",
    email: identity.email,
    accountId: identity.accountId,
    plan: identity.plan,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: tokenUpdate(tokens).expiresAt,
    ownerUserId: input.ownerUserId,
    shared: input.shared,
    metadata: {
      subject: identity.subject,
      issuer: codexOAuthIssuer(),
      source: "oauth",
    },
  });
}

// -- Device authorization (recommended for hosted/headless deployments) ------

export async function beginCodexDeviceFlow(input: {
  ownerUserId?: string;
  shared?: boolean;
} = {}): Promise<CodexDeviceFlow> {
  const issuer = codexOAuthIssuer();
  const response = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "model-proxy/2.0",
    },
    body: JSON.stringify({ client_id: codexClientId() }),
  });
  if (!response.ok) {
    throw new Error(`Failed to initiate Codex device authorization (${response.status})`);
  }
  const data = (await response.json()) as {
    device_auth_id?: unknown;
    user_code?: unknown;
    interval?: unknown;
  };
  if (typeof data.device_auth_id !== "string" || typeof data.user_code !== "string") {
    throw new Error("Codex device authorization returned an invalid response");
  }
  const now = new Date();
  const intervalSeconds =
    typeof data.interval === "string"
      ? Number.parseInt(data.interval, 10)
      : typeof data.interval === "number"
        ? data.interval
        : 5;
  return {
    id: randomBytes(18).toString("base64url"),
    deviceAuthId: data.device_auth_id,
    userCode: data.user_code,
    verificationUrl: `${issuer}/codex/device`,
    intervalMs: Math.max(Number.isFinite(intervalSeconds) ? intervalSeconds : 5, 1) * 1_000,
    ownerUserId: input.ownerUserId,
    shared: input.shared === true,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + FLOW_TTL_MS).toISOString(),
  };
}

export async function pollCodexDeviceFlow(
  flow: CodexDeviceFlow,
  signal?: AbortSignal,
): Promise<ProviderAccount> {
  while (Date.parse(flow.expiresAt) > Date.now()) {
    if (signal?.aborted === true) throw new DOMException("Device authorization aborted", "AbortError");
    const response = await fetch(`${codexOAuthIssuer()}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "model-proxy/2.0",
      },
      body: JSON.stringify({
        device_auth_id: flow.deviceAuthId,
        user_code: flow.userCode,
      }),
      signal,
    });
    if (response.ok) {
      const data = (await response.json()) as {
        authorization_code?: unknown;
        code_verifier?: unknown;
      };
      if (
        typeof data.authorization_code !== "string" ||
        typeof data.code_verifier !== "string"
      ) {
        throw new Error("Codex device authorization returned an invalid token response");
      }
      const tokens = await exchangeCodexCode({
        code: data.authorization_code,
        verifier: data.code_verifier,
        redirectUri: `${codexOAuthIssuer()}/deviceauth/callback`,
      });
      return createCodexAccountFromTokens(tokens, {
        ownerUserId: flow.ownerUserId,
        shared: flow.shared,
      });
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Codex device authorization failed (${response.status})`);
    }
    await abortableSleep(flow.intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, signal);
  }
  throw new Error("Codex device authorization expired");
}

// -- Existing local Codex credentials ----------------------------------------

interface CodexAuthFile {
  tokens?: {
    access_token?: unknown;
    refresh_token?: unknown;
    id_token?: unknown;
  };
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
  last_refresh?: unknown;
}

export function defaultCodexAuthPath(): string {
  return process.env["CODEX_HOME"] !== undefined
    ? join(process.env["CODEX_HOME"]!, "auth.json")
    : join(homedir(), ".codex", "auth.json");
}

export function importCodexAuthFile(input: {
  path?: string;
  ownerUserId?: string;
  shared?: boolean;
  label?: string;
} = {}): ProviderAccount {
  const path = input.path ?? defaultCodexAuthPath();
  const file = JSON.parse(readFileSync(path, "utf8")) as CodexAuthFile;
  const nested = file.tokens ?? {};
  const access =
    typeof nested.access_token === "string"
      ? nested.access_token
      : typeof file.access_token === "string"
        ? file.access_token
        : undefined;
  const refresh =
    typeof nested.refresh_token === "string"
      ? nested.refresh_token
      : typeof file.refresh_token === "string"
        ? file.refresh_token
        : undefined;
  const idToken =
    typeof nested.id_token === "string"
      ? nested.id_token
      : typeof file.id_token === "string"
        ? file.id_token
        : undefined;
  if (access === undefined) throw new Error(`No Codex access token found in ${path}`);
  const account = createCodexAccountFromTokens(
    {
      access_token: access,
      refresh_token: refresh,
      id_token: idToken,
    },
    {
      ownerUserId: input.ownerUserId,
      shared: input.shared,
      label: input.label,
    },
  );
  log.info("imported local Codex credentials", { accountId: account.id, path });
  return account;
}

// -- Local callback listener --------------------------------------------------

export function ensureCodexCallbackServer(): boolean {
  if (callbackServer !== undefined) return true;
  if ((process.env["CODEX_OAUTH_CALLBACK_SERVER"] ?? "true").toLowerCase() === "false") {
    return false;
  }
  try {
    callbackServer = Bun.serve({
      hostname: "127.0.0.1",
      port: CODEX_OAUTH_REDIRECT_PORT,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname !== CODEX_OAUTH_REDIRECT_PATH) {
          return new Response("Not found", { status: 404 });
        }
        try {
          const account = await completeCodexBrowserFlow({ callbackUrl: url.toString() });
          return new Response(callbackPage(true, `Connected ${account.email ?? account.label}.`), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        } catch (error) {
          return new Response(callbackPage(false, (error as Error).message), {
            status: 400,
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      },
    });
    return true;
  } catch (error) {
    // Port 1455 is optional. Remote deployments can paste the callback URL,
    // and hosted/headless deployments should prefer device authorization.
    log.warn("Codex OAuth callback listener unavailable", { error: String(error) });
    return false;
  }
}

export function stopCodexCallbackServerForTests(): void {
  callbackServer?.stop(true);
  callbackServer = undefined;
  pendingFlows.clear();
}

function publicFlow(flow: InternalPendingFlow): PendingCodexFlow {
  return {
    id: flow.id,
    state: flow.state,
    authorizeUrl: flow.authorizeUrl,
    ownerUserId: flow.ownerUserId,
    shared: flow.shared,
    createdAt: flow.createdAt,
    expiresAt: flow.expiresAt,
  };
}

function pruneExpiredFlows(): void {
  const now = Date.now();
  for (const [state, flow] of pendingFlows) {
    if (Date.parse(flow.expiresAt) <= now) pendingFlows.delete(state);
  }
}

async function tokenRequest(
  issuer: string,
  fields: Record<string, string>,
): Promise<CodexTokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields).toString(),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Codex token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("Codex token exchange returned invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>)["access_token"] !== "string"
  ) {
    throw new Error("Codex token exchange response is missing access_token");
  }
  return parsed as CodexTokenResponse;
}

function tokenUpdate(tokens: CodexTokenResponse): {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt?: string;
} {
  const expiresIn =
    typeof tokens.expires_in === "number" && Number.isFinite(tokens.expires_in)
      ? tokens.expires_in
      : 3_600;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
  };
}

function callbackPage(success: boolean, message: string): string {
  const title = success ? "Account connected" : "Connection failed";
  const safe = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
    `<body style="font-family:system-ui;padding:3rem;background:#111;color:#eee">` +
    `<h1>${title}</h1><p>${safe}</p><p>You can close this window.</p></body></html>`;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}
