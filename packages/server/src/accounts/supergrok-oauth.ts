import { sleep } from "../shared/utils.ts";
import { randomBytes } from "node:crypto";

import {
  createAccount,
  updateAccountTokens,
  type ProviderAccount,
} from "../storage/account-store.ts";
import { parseJwtClaims } from "./codex-oauth.ts";

export const SUPERGROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const SUPERGROK_AUTH_ISSUER = "https://auth.x.ai";
export const SUPERGROK_SCOPE =
  "openid profile email offline_access grok-cli:access api:access";
export const SUPERGROK_DEVICE_GRANT =
  "urn:ietf:params:oauth:grant-type:device_code";

export interface SuperGrokDeviceFlow {
  id: string;
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  ownerUserId: string | undefined;
  shared: boolean;
  expiresAt: string;
}

interface SuperGrokTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

function issuer(): string {
  return (process.env["SUPERGROK_OAUTH_ISSUER"] ?? SUPERGROK_AUTH_ISSUER)
    .trim()
    .replace(/\/+$/, "");
}

function clientId(): string {
  return (process.env["SUPERGROK_CLIENT_ID"] ?? SUPERGROK_CLIENT_ID).trim();
}

export async function beginSuperGrokDeviceFlow(input: {
  ownerUserId?: string;
  shared?: boolean;
} = {}): Promise<SuperGrokDeviceFlow> {
  const response = await formRequest(`${issuer()}/oauth2/device/code`, {
    client_id: clientId(),
    scope: SUPERGROK_SCOPE,
  });
  if (!response.ok) {
    throw new Error(
      `xAI device authorization failed (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }
  const value = (await response.json()) as Record<string, unknown>;
  const deviceCode = stringField(value, "device_code")!;
  const userCode = stringField(value, "user_code")!;
  const verificationUrl =
    stringField(value, "verification_uri_complete", false) ??
    stringField(value, "verification_uri")!;
  const interval = numberField(value["interval"], 5);
  const expiresIn = numberField(value["expires_in"], 1_800);
  return {
    id: randomBytes(18).toString("base64url"),
    deviceCode,
    userCode,
    verificationUrl,
    intervalMs: interval * 1_000,
    ownerUserId: input.ownerUserId,
    shared: input.shared === true,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
  };
}

export async function pollSuperGrokDeviceFlow(
  flow: SuperGrokDeviceFlow,
  signal?: AbortSignal,
): Promise<ProviderAccount> {
  while (Date.parse(flow.expiresAt) > Date.now()) {
    if (signal?.aborted === true) throw new DOMException("Aborted", "AbortError");
    const response = await formRequest(
      `${issuer()}/oauth2/token`,
      {
        grant_type: SUPERGROK_DEVICE_GRANT,
        device_code: flow.deviceCode,
        client_id: clientId(),
      },
      signal,
    );
    const text = await response.text();
    if (response.ok) {
      return createSuperGrokAccount(parseTokenResponse(text), {
        ownerUserId: flow.ownerUserId,
        shared: flow.shared,
      });
    }
    let code = "";
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      code = typeof parsed["error"] === "string" ? parsed["error"] : "";
    } catch {
      // handled below
    }
    if (code === "authorization_pending") {
      await sleep(flow.intervalMs, signal);
      continue;
    }
    if (code === "slow_down") {
      await sleep(flow.intervalMs + 5_000, signal);
      continue;
    }
    throw new Error(`xAI device authorization failed (${response.status}): ${text.slice(0, 300)}`);
  }
  throw new Error("xAI device authorization expired");
}

export async function refreshSuperGrokAccount(
  account: ProviderAccount,
): Promise<ProviderAccount> {
  if (account.refreshToken === undefined) throw new Error("SuperGrok account has no refresh token");
  const response = await formRequest(`${issuer()}/oauth2/token`, {
    grant_type: "refresh_token",
    client_id: clientId(),
    refresh_token: account.refreshToken,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`xAI token refresh failed (${response.status}): ${text.slice(0, 300)}`);
  }
  const tokens = parseTokenResponse(text);
  const updated = updateAccountTokens(account.id, tokenUpdate(tokens));
  if (updated === undefined) throw new Error("SuperGrok account was deleted while refreshing");
  return updated;
}

function createSuperGrokAccount(
  tokens: SuperGrokTokenResponse,
  input: { ownerUserId?: string; shared?: boolean },
): ProviderAccount {
  const claims =
    (tokens.id_token !== undefined ? parseJwtClaims(tokens.id_token) : undefined) ??
    parseJwtClaims(tokens.access_token);
  return createAccount({
    provider: "supergrok",
    kind: "oauth",
    label: claims?.email ?? "SuperGrok subscription",
    email: claims?.email,
    accountId: claims?.sub,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: tokenUpdate(tokens).expiresAt,
    ownerUserId: input.ownerUserId,
    shared: input.shared,
    metadata: { source: "oauth-device", issuer: issuer() },
  });
}

function tokenUpdate(tokens: SuperGrokTokenResponse): {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: string;
} {
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    idToken: tokens.id_token,
    expiresAt: new Date(Date.now() + (tokens.expires_in ?? 3_600) * 1_000).toISOString(),
  };
}

function parseTokenResponse(text: string): SuperGrokTokenResponse {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("xAI token endpoint returned invalid JSON");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>)["access_token"] !== "string"
  ) {
    throw new Error("xAI token endpoint response is missing access_token");
  }
  return value as SuperGrokTokenResponse;
}

function formRequest(
  url: string,
  fields: Record<string, string>,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields).toString(),
    signal,
  });
}

function stringField(
  value: Record<string, unknown>,
  key: string,
  required = true,
): string | undefined {
  const field = value[key];
  if (typeof field === "string" && field.length > 0) return field;
  if (required) throw new Error(`xAI device authorization response is missing ${key}`);
  return undefined;
}

function numberField(value: unknown, fallback: number): number {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

