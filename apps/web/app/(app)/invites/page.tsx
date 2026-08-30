"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Panel, PanelBody } from "@/components/ui/panel";
import {
  createInviteAdmin,
  getSignupSettingsAdmin,
  listInvitesAdmin,
  saveSignupSettingsAdmin,
  type InviteRecord,
  type SignupSettings,
} from "@/lib/endpoints";

export default function InvitesPage(): React.ReactElement {
  return (
        <InvitesBody />
  );
}

function InvitesBody(): React.ReactElement {
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [settings, setSettings] = useState<SignupSettings | undefined>();
  const [email, setEmail] = useState("");
  const [lastToken, setLastToken] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  const reload = (): void => {
    void Promise.all([listInvitesAdmin(), getSignupSettingsAdmin()])
      .then(([inviteResult, settingsResult]) => {
        setInvites(inviteResult.invites);
        setSettings(settingsResult.signup);
      })
      .catch((err) => setError((err as Error).message));
  };

  useEffect(reload, []);

  const createInvite = async (): Promise<void> => {
    setError(undefined);
    try {
      const result = await createInviteAdmin(email.trim() === "" ? {} : { email });
      setLastToken(result.token);
      setEmail("");
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleInviteMode = async (): Promise<void> => {
    if (settings === undefined) return;
    const next = await saveSignupSettingsAdmin({
      multi_user_enabled: true,
      invite_signup_enabled: !settings.inviteSignupEnabled,
      open_signup_enabled: settings.openSignupEnabled,
    });
    setSettings(next.signup);
  };

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="admin" title="Invites" description="One-time account creation links and signup modes." />
      {error !== undefined ? <div className="text-alert-500">{error}</div> : null}
      <Panel title="signup mode">
        <PanelBody className="flex flex-wrap items-center gap-3">
          <div className="font-mono text-xs text-bone-500">
            invite signup is {settings?.inviteSignupEnabled ? "enabled" : "disabled"}
          </div>
          <Button onClick={toggleInviteMode}>{settings?.inviteSignupEnabled ? "disable" : "enable"} invite signup</Button>
        </PanelBody>
      </Panel>
      <Panel title="create invite">
        <PanelBody className="space-y-4">
          <div>
            <Label htmlFor="invite-email">Email, optional</Label>
            <Input id="invite-email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </div>
          <Button onClick={() => void createInvite()}>create invite</Button>
          {lastToken !== undefined ? (
            <pre className="overflow-auto bg-ink-900 p-3 text-xs text-bone-900">{`${window.location.origin}/signup?invite_token=${lastToken}`}</pre>
          ) : null}
        </PanelBody>
      </Panel>
      <Panel title="existing invites" bodyClassName="divide-y divide-ink-500">
        {invites.map((invite) => (
          <div key={invite.id} className="p-5 font-mono text-xs text-bone-500">
            {invite.email ?? "any email"} · expires {new Date(invite.expiresAt).toLocaleString()} · {invite.usedAt ? "used" : "unused"}
          </div>
        ))}
        {invites.length === 0 ? <PanelBody>No invites yet.</PanelBody> : null}
      </Panel>
    </div>
  );
}
