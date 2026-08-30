"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Panel, PanelBody } from "@/components/ui/panel";
import {
  attachProviderToken,
  completeCodexOAuth,
  getMe,
  importLocalCodexAccount,
  listProviderAccounts,
  pollAccountDeviceFlow,
  refreshProviderAccount,
  removeProviderAccount,
  startAccountDeviceFlow,
  startCodexOAuth,
  updateProviderAccount,
  type DeviceFlowRecord,
  type PrincipalInfo,
  type ProviderAccountRecord,
} from "@/lib/endpoints";

/** Attach and manage provider subscription accounts (ChatGPT/Codex, SuperGrok,
 * raw tokens). Available to every authenticated user; admins can additionally
 * share accounts and import local server credentials. */
export function ProviderAccountsSection(): React.ReactElement {
  const [accounts, setAccounts] = useState<ProviderAccountRecord[]>([]);
  const [principal, setPrincipal] = useState<PrincipalInfo>();
  const [shared, setShared] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [deviceFlow, setDeviceFlow] = useState<{
    provider: "codex" | "supergrok";
    flow: DeviceFlowRecord;
  }>();
  const [tokenProvider, setTokenProvider] = useState("openai");
  const [tokenLabel, setTokenLabel] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const reload = useCallback((): void => {
    void Promise.all([listProviderAccounts(), getMe()])
      .then(([accountResult, me]) => {
        setAccounts(accountResult.accounts);
        setPrincipal(me.principal);
      })
      .catch((reason: unknown) => setError((reason as Error).message));
  }, []);

  useEffect(reload, [reload]);

  const isAdmin =
    principal?.isOwner === true ||
    principal?.role === "owner" ||
    principal?.role === "admin";

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    setBusy(key);
    setError(undefined);
    setMessage(undefined);
    try {
      await action();
      reload();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const browserLogin = (): void => {
    void run("codex-browser", async () => {
      const result = await startCodexOAuth(shared);
      window.open(result.flow.authorize_url, "_blank", "noopener,noreferrer");
      setMessage(
        "Authorization opened. Local installs finish automatically; remote installs paste the final localhost callback URL below.",
      );
    });
  };

  const completeBrowser = (): void => {
    void run("codex-complete", async () => {
      await completeCodexOAuth(callbackUrl);
      setCallbackUrl("");
      setMessage("ChatGPT account connected.");
    });
  };

  const startDevice = (provider: "codex" | "supergrok"): void => {
    void run(`${provider}-device`, async () => {
      const result = await startAccountDeviceFlow(provider, shared);
      setDeviceFlow({ provider, flow: result.flow });
      window.open(result.flow.verification_url, "_blank", "noopener,noreferrer");
      setMessage(`Enter code ${result.flow.user_code} in the opened authorization page.`);
    });
  };

  const pollDevice = (): void => {
    if (deviceFlow === undefined) return;
    void run("device-poll", async () => {
      await pollAccountDeviceFlow(deviceFlow.provider, deviceFlow.flow.id);
      setDeviceFlow(undefined);
      setMessage("Subscription account connected.");
    });
  };

  return (
    <div className="space-y-5">
      {error !== undefined ? (
        <div className="border border-alert-500/40 bg-alert-500/10 p-3 font-mono text-xs text-alert-500">
          {error}
        </div>
      ) : null}
      {message !== undefined ? (
        <div className="border border-phosphor-500/30 bg-phosphor-50 p-3 font-mono text-xs text-phosphor-500">
          {message}
        </div>
      ) : null}

      {isAdmin ? (
        <label className="flex items-center gap-3 font-mono text-xs text-bone-500">
          <input
            type="checkbox"
            checked={shared}
            onChange={(event) => setShared(event.target.checked)}
            className="accent-phosphor-500"
          />
          Share newly attached account with every authenticated user
        </label>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="ChatGPT / Codex" badge={<Badge tone="phosphor">primary</Badge>} accent>
          <PanelBody className="space-y-5">
            <p className="text-sm leading-6 text-bone-500">
              Connect ChatGPT Plus, Pro, Team, or Enterprise through the same OAuth PKCE
              flow as the official Codex CLI. Start this flow repeatedly to attach
              multiple accounts.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={browserLogin}
                disabled={busy !== undefined}
              >
                {busy === "codex-browser" ? "starting…" : "connect in browser"}
              </Button>
              <Button
                variant="outline"
                onClick={() => startDevice("codex")}
                disabled={busy !== undefined}
              >
                headless / device code
              </Button>
              {isAdmin ? (
                <Button
                  variant="ghost"
                  disabled={busy !== undefined}
                  onClick={() =>
                    void run("codex-import", async () => {
                      await importLocalCodexAccount();
                      setMessage("Imported the server's ~/.codex/auth.json.");
                    })
                  }
                >
                  import local Codex
                </Button>
              ) : null}
            </div>
            <div className="border-t border-ink-500 pt-4">
              <Label htmlFor="callback-url" hint="remote deployments only">
                Localhost callback URL
              </Label>
              <div className="mt-2 flex gap-2">
                <Input
                  id="callback-url"
                  value={callbackUrl}
                  onChange={(event) => setCallbackUrl(event.target.value)}
                  placeholder="http://localhost:1455/auth/callback?code=…&state=…"
                  monospace
                />
                <Button
                  variant="outline"
                  onClick={completeBrowser}
                  disabled={busy !== undefined || callbackUrl.trim().length === 0}
                >
                  complete
                </Button>
              </div>
            </div>
          </PanelBody>
        </Panel>

        <Panel title="SuperGrok / X Premium+" badge={<Badge tone="warning">OAuth</Badge>}>
          <PanelBody className="space-y-5">
            <p className="text-sm leading-6 text-bone-500">
              Device-code OAuth for the Grok CLI subscription surface. xAI controls
              account entitlement and may reject unsupported subscription tiers with 403.
            </p>
            <Button
              onClick={() => startDevice("supergrok")}
              disabled={busy !== undefined}
            >
              {busy === "supergrok-device" ? "starting…" : "connect SuperGrok"}
            </Button>
          </PanelBody>
        </Panel>
      </div>

      {deviceFlow !== undefined ? (
        <Panel title={`${deviceFlow.provider} device authorization`} accent>
          <PanelBody className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-mono text-3xl tracking-[0.24em] text-phosphor-500">
                {deviceFlow.flow.user_code}
              </div>
              <a
                href={deviceFlow.flow.verification_url}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block font-mono text-xs text-bone-500 underline"
              >
                {deviceFlow.flow.verification_url}
              </a>
            </div>
            <Button onClick={pollDevice} disabled={busy !== undefined}>
              {busy === "device-poll" ? "waiting for approval…" : "I approved - finish"}
            </Button>
          </PanelBody>
        </Panel>
      ) : null}

      <Panel title="Attach a provider token" subtitle="API keys and non-OAuth subscriptions">
        <PanelBody className="grid gap-4 md:grid-cols-[1fr_1fr_2fr_auto] md:items-end">
          <div>
            <Label htmlFor="token-provider">Provider</Label>
            <Input
              id="token-provider"
              value={tokenProvider}
              onChange={(event) => setTokenProvider(event.target.value)}
              placeholder="openai"
              monospace
            />
          </div>
          <div>
            <Label htmlFor="token-label">Label</Label>
            <Input
              id="token-label"
              value={tokenLabel}
              onChange={(event) => setTokenLabel(event.target.value)}
              placeholder="Work account"
            />
          </div>
          <div>
            <Label htmlFor="provider-token">Access token</Label>
            <Input
              id="provider-token"
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="token is encrypted before storage"
              monospace
            />
          </div>
          <Button
            disabled={busy !== undefined || token.trim().length === 0}
            onClick={() =>
              void run("token", async () => {
                await attachProviderToken({
                  provider: tokenProvider.trim(),
                  label: tokenLabel.trim() || undefined,
                  access_token: token.trim(),
                  shared,
                });
                setToken("");
                setTokenLabel("");
                setMessage("Provider token attached.");
              })
            }
          >
            attach
          </Button>
        </PanelBody>
      </Panel>

      <Panel
        title="Connected accounts"
        subtitle={`${accounts.length} visible · ${accounts.filter((account) => account.status === "active").length} active`}
        bodyClassName="divide-y divide-ink-500"
      >
        {accounts.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            busy={busy}
            onRun={run}
          />
        ))}
        {accounts.length === 0 ? (
          <PanelBody className="text-sm text-bone-500">
            No subscription accounts attached yet.
          </PanelBody>
        ) : null}
      </Panel>
    </div>
  );
}

function AccountRow({
  account,
  busy,
  onRun,
}: {
  account: ProviderAccountRecord;
  busy: string | undefined;
  onRun: (key: string, action: () => Promise<void>) => Promise<void>;
}): React.ReactElement {
  const tone =
    account.status === "active" ? "phosphor" : account.status === "error" ? "danger" : "muted";
  return (
    <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-bone-900">{account.label}</span>
          <Badge tone={tone}>{account.status}</Badge>
          <Badge tone="muted">{account.provider}</Badge>
          {account.shared ? <Badge tone="bone">shared</Badge> : <Badge tone="muted">personal</Badge>}
        </div>
        <div className="mt-2 font-mono text-[11px] text-bone-300">
          {account.email ?? account.account_id ?? account.id}
          {account.plan !== undefined ? ` · ${account.plan}` : ""}
          {account.expires_at !== undefined
            ? ` · token expires ${new Date(account.expires_at).toLocaleString()}`
            : ""}
        </div>
        {account.last_error !== undefined ? (
          <div className="mt-2 text-xs text-alert-500">{account.last_error}</div>
        ) : null}
      </div>
      {account.can_manage ? (
        <div className="flex flex-wrap gap-2">
          {account.kind === "oauth" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== undefined}
              onClick={() =>
                void onRun(`refresh-${account.id}`, async () => {
                  await refreshProviderAccount(account.id);
                })
              }
            >
              refresh
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            disabled={busy !== undefined}
            onClick={() =>
              void onRun(`toggle-${account.id}`, async () => {
                await updateProviderAccount(account.id, {
                  status: account.status === "disabled" ? "active" : "disabled",
                });
              })
            }
          >
            {account.status === "disabled" ? "enable" : "disable"}
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={busy !== undefined}
            onClick={() =>
              void onRun(`remove-${account.id}`, async () => {
                await removeProviderAccount(account.id);
              })
            }
          >
            remove
          </Button>
        </div>
      ) : null}
    </div>
  );
}
