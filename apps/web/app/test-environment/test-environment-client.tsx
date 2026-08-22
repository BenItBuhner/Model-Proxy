"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { AuthGuard } from "@/components/auth-guard";
import { PageHeader } from "@/components/page-header";
import { EnvBody } from "@/components/env/env-body";
import { TestBody } from "@/components/test/test-body";
import { AudioBody } from "@/components/audio/audio-body";
import { cn } from "@/lib/utils";

type LabTab = "env" | "test" | "audio";

export function TestEnvironmentClient(): React.ReactElement {
  const router = useRouter();
  const pathname = usePathname() ?? "/test-environment";
  const searchParams = useSearchParams();

  const tab: LabTab = useMemo(() => {
    const raw = searchParams.get("tab");
    if (raw === "audio") return "audio";
    return raw === "env" ? "env" : "test";
  }, [searchParams]);

  const setTab = useCallback(
    (next: LabTab) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", next);
      const q = params.toString();
      router.replace(q.length > 0 ? `${pathname}?${q}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  return (
    <AuthGuard>
      <AppShell>
        <PageHeader
          eyebrow="lab"
          title="Test environment"
          description="Edit runtime .env values and exercise the request workbench against your routed models—secrets apply live, and the workbench streams per-request proxy events."
        />

        <div className="mb-8 flex flex-wrap gap-2 border-b border-ink-500 pb-6">
          <button
            type="button"
            onClick={() => setTab("env")}
            className={cn(
              "border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors",
              tab === "env"
                ? "border-phosphor-500 bg-phosphor-50 text-bone-900"
                : "border-ink-500 text-bone-500 hover:border-ink-200 hover:bg-ink-700 hover:text-bone-900",
            )}
          >
            Environment
          </button>
          <button
            type="button"
            onClick={() => setTab("test")}
            className={cn(
              "border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors",
              tab === "test"
                ? "border-phosphor-500 bg-phosphor-50 text-bone-900"
                : "border-ink-500 text-bone-500 hover:border-ink-200 hover:bg-ink-700 hover:text-bone-900",
            )}
          >
            Test
          </button>
          <button
            type="button"
            onClick={() => setTab("audio")}
            className={cn(
              "border px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors",
              tab === "audio"
                ? "border-phosphor-500 bg-phosphor-50 text-bone-900"
                : "border-ink-500 text-bone-500 hover:border-ink-200 hover:bg-ink-700 hover:text-bone-900",
            )}
          >
            Audio
          </button>
        </div>

        {tab === "env" ? (
          <EnvBody embedded />
        ) : tab === "audio" ? (
          <AudioBody embedded />
        ) : (
          <TestBody embedded />
        )}
      </AppShell>
    </AuthGuard>
  );
}
