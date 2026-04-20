"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getStoredApiKey } from "@/lib/api";
import { authStatus } from "@/lib/endpoints";

type GuardState = "checking" | "authenticated" | "unauthenticated";

export function AuthGuard({ children }: { children: React.ReactNode }): React.ReactElement | null {
  const router = useRouter();
  const [state, setState] = useState<GuardState>("checking");

  useEffect(() => {
    let cancelled = false;
    const storedKey = getStoredApiKey();
    if (storedKey === undefined) {
      setState("unauthenticated");
      router.replace("/login");
      return;
    }
    authStatus()
      .then((result) => {
        if (cancelled) return;
        if (result.authenticated) {
          setState("authenticated");
        } else {
          setState("unauthenticated");
          router.replace("/login");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState("unauthenticated");
        router.replace("/login");
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (state === "checking") {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-bone-500 animate-slow-pulse">
          [verifying session]
        </div>
      </div>
    );
  }
  if (state === "unauthenticated") return null;
  return <>{children}</>;
}
