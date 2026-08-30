"use client";

import { AuthGuard } from "@/components/auth-guard";
import { AppShell } from "@/components/app-shell";

export default function AppLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
