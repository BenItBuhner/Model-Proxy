"use client";

import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { EnvBody } from "@/components/env/env-body";

export default function EnvPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <EnvBody />
      </AppShell>
    </AuthGuard>
  );
}
