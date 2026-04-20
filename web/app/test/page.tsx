"use client";

import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { TestBody } from "@/components/test/test-body";

export default function TestPage(): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>
        <TestBody />
      </AppShell>
    </AuthGuard>
  );
}
