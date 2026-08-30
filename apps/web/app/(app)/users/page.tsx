"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Panel, PanelBody } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  getUserEntitlements,
  getUserLimits,
  listUsersAdmin,
  saveUserEntitlements,
  saveUserLimits,
  type UserRecord,
} from "@/lib/endpoints";

export default function UsersPage(): React.ReactElement {
  return (
        <UsersBody />
  );
}

const LIMIT_FIELDS = [
  { key: "requestsPerMinute", label: "Requests / minute" },
  { key: "requestsPerDay", label: "Requests / day" },
  { key: "tokensPerDay", label: "Tokens / day" },
  { key: "costUsdPerDay", label: "Cost USD / day" },
  { key: "concurrentRequests", label: "Concurrent requests" },
] as const;

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
      <PageHeader
        eyebrow="admin"
        title="Users"
        description="Accounts, roles, per-user model access, and rate limits."
      />
      {error !== undefined ? <div className="text-alert-500">{error}</div> : null}
      <Panel title="user accounts" bodyClassName="divide-y divide-ink-500">
        {users.map((user) => (
          <UserRow key={user.id} user={user} />
        ))}
        {users.length === 0 ? <PanelBody>No users yet.</PanelBody> : null}
      </Panel>
    </div>
  );
}

function UserRow({ user }: { user: UserRecord }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState("");
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | undefined>();
  const [loaded, setLoaded] = useState(false);

  async function load(): Promise<void> {
    try {
      const [entitlementsResult, limitsResult] = await Promise.all([
        getUserEntitlements(user.id),
        getUserLimits(user.id),
      ]);
      const allowedModels = entitlementsResult.entitlements
        .filter(
          (entry) =>
            entry["resource_type"] === "model" &&
            entry["allowed"] !== false &&
            typeof entry["resource_id"] === "string",
        )
        .map((entry) => entry["resource_id"] as string);
      setModels(Array.from(new Set(allowedModels)).sort().join("\n"));
      const nextLimits: Record<string, string> = {};
      for (const field of LIMIT_FIELDS) {
        const value = limitsResult.limits[field.key];
        nextLimits[field.key] = typeof value === "number" ? String(value) : "";
      }
      setLimits(nextLimits);
      setLoaded(true);
      setStatus(undefined);
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  }

  async function toggle(): Promise<void> {
    const next = !open;
    setOpen(next);
    if (next && !loaded) await load();
  }

  async function save(): Promise<void> {
    setStatus("saving…");
    try {
      const modelIds = models
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const entitlements = modelIds.flatMap((model) => [
        { resource_type: "model", resource_id: model, allowed: true },
        { resource_type: "fusion_model", resource_id: model, allowed: true },
      ]);
      const limitsBody: Record<string, number> = {};
      for (const field of LIMIT_FIELDS) {
        const raw = limits[field.key]?.trim() ?? "";
        if (raw.length === 0) continue;
        const parsed = Number(raw);
        if (Number.isFinite(parsed) && parsed >= 0) limitsBody[field.key] = parsed;
      }
      await Promise.all([
        saveUserEntitlements(user.id, entitlements),
        saveUserLimits(user.id, limitsBody),
      ]);
      setStatus("saved");
    } catch (err) {
      setStatus(`error: ${(err as Error).message}`);
    }
  }

  return (
    <div className="p-5">
      <div className="grid gap-2 md:grid-cols-[1fr_auto_auto] md:items-center">
        <div>
          <div className="font-mono text-sm text-bone-900">{user.email}</div>
          <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
            {user.role} · {user.status} · completions {user.completionLoggingEnabled ? "on" : "off"}
          </div>
        </div>
        <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
          created {new Date(user.createdAt).toLocaleString()}
        </div>
        <Button variant="outline" size="sm" onClick={toggle}>
          {open ? "close" : "manage"}
        </Button>
      </div>

      {open ? (
        <div className="mt-5 grid gap-5 border-t border-ink-500 pt-5 lg:grid-cols-2">
          <div>
            <Label htmlFor={`models-${user.id}`} hint="one logical model per line · fusion access included">
              Allowed models
            </Label>
            <Textarea
              id={`models-${user.id}`}
              rows={6}
              value={models}
              onChange={(event) => setModels(event.target.value)}
              placeholder={"turbo\nglm-5.2"}
            />
          </div>
          <div className="space-y-3">
            {LIMIT_FIELDS.map((field) => (
              <div key={field.key} className="grid grid-cols-[1fr_14ch] items-center gap-3">
                <Label htmlFor={`${field.key}-${user.id}`}>{field.label}</Label>
                <Input
                  id={`${field.key}-${user.id}`}
                  monospace
                  placeholder="unlimited"
                  value={limits[field.key] ?? ""}
                  onChange={(event) =>
                    setLimits({ ...limits, [field.key]: event.target.value })
                  }
                />
              </div>
            ))}
            <div className="flex items-center gap-3 pt-1">
              <Button size="sm" onClick={save}>save access + limits</Button>
              {status !== undefined ? (
                <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
                  {status}
                </span>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
