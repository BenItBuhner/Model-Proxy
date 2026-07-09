"use client";

import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelBody } from "@/components/ui/panel";
import { listUsersAdmin, type UserRecord } from "@/lib/endpoints";

export default function UsersPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <UsersBody />
      </AppShell>
    </AuthGuard>
  );
}

function UsersBody(): React.ReactElement {
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    listUsersAdmin()
      .then((result) => setUsers(result.users))
      .catch((err) => setError((err as Error).message));
  }, []);

  return (
    <div className="space-y-6">
      <PageHeader eyebrow="admin" title="Users" description="Accounts, roles, and access management." />
      {error !== undefined ? <div className="text-alert-500">{error}</div> : null}
      <Panel title="user accounts" bodyClassName="divide-y divide-ink-500">
        {users.map((user) => (
          <div key={user.id} className="grid gap-2 p-5 md:grid-cols-[1fr_auto]">
            <div>
              <div className="font-mono text-sm text-bone-900">{user.email}</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
                {user.role} · {user.status} · completions {user.completionLoggingEnabled ? "on" : "off"}
              </div>
            </div>
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
              created {new Date(user.createdAt).toLocaleString()}
            </div>
          </div>
        ))}
        {users.length === 0 ? <PanelBody>No users yet.</PanelBody> : null}
      </Panel>
    </div>
  );
}
