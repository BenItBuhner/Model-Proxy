"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearStoredApiKey } from "@/lib/api";
import {
  authStatus,
  getHealth,
  logout as logoutRequest,
  type HealthDetailed,
} from "@/lib/endpoints";
import { StatusDot } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href: string;
  code: string;
}

const NAV: NavItem[] = [
  { code: "01", label: "Overview", href: "/" },
  { code: "02", label: "Models", href: "/models" },
  { code: "03", label: "Providers", href: "/providers" },
  { code: "04", label: "Config", href: "/config" },
  { code: "05", label: "Test environment", href: "/test-environment" },
  { code: "06", label: "Logs", href: "/logs" },
];

function isNavActive(pathname: string, item: NavItem): boolean {
  if (item.href === "/") {
    return pathname === "/";
  }
  if (item.href === "/test-environment") {
    return (
      pathname === "/test-environment" ||
      pathname.startsWith("/test-environment/") ||
      pathname === "/env" ||
      pathname.startsWith("/env/") ||
      pathname === "/test" ||
      pathname.startsWith("/test/")
    );
  }
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [health, setHealth] = useState<HealthDetailed | undefined>(undefined);
  const [healthErr, setHealthErr] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await authStatus();
        const detail = await getHealth();
        if (!cancelled) setHealth(detail);
      } catch (err) {
        if (!cancelled) setHealthErr((err as Error).message);
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const handleLogout = async (): Promise<void> => {
    try {
      await logoutRequest();
    } catch {
      // ignore
    }
    clearStoredApiKey();
    router.replace("/login");
  };

  return (
    <div className="min-h-screen">
      <div className="mx-auto flex min-h-screen max-w-[1400px] px-6 py-8">
        <aside className="hidden w-[240px] shrink-0 lg:flex flex-col gap-8 pr-8">
          <BrandMark />
          <nav className="flex flex-col gap-1">
            {NAV.map((item) => {
              const active = isNavActive(pathname, item);
              return (
                <Link
                  key={item.code}
                  href={item.href}
                  className={cn(
                    "group flex items-center justify-between border-l-2 border-transparent px-3 py-2 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors",
                    active
                      ? "border-phosphor-500 bg-phosphor-50 text-bone-900"
                      : "text-bone-500 hover:border-ink-200 hover:bg-ink-700 hover:text-bone-900",
                  )}
                >
                  <span className="flex items-center gap-3">
                    <span
                      className={cn(
                        "text-bone-300 group-hover:text-phosphor-500",
                        active && "text-phosphor-500",
                      )}
                    >
                      {item.code}
                    </span>
                    {item.label}
                  </span>
                  {active ? (
                    <span className="text-phosphor-500">›</span>
                  ) : null}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto flex flex-col gap-3 border-t border-ink-500 pt-4">
            <SystemStatus health={health} error={healthErr} />
            <button
              onClick={handleLogout}
              className="text-left font-mono text-[10px] uppercase tracking-[0.2em] text-bone-300 transition-colors hover:text-alert-500"
            >
              ← Sign out
            </button>
          </div>
        </aside>

        <main className="flex-1 min-w-0 animate-flicker-in">
          {children}
        </main>
      </div>
    </div>
  );
}

function BrandMark(): React.ReactElement {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="h-6 w-6 bg-phosphor-500 shadow-[0_0_16px_rgba(205,255,0,0.6)]" />
          <div className="absolute inset-0 border border-ink-900" />
        </div>
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.24em] text-bone-900">
            Model / Proxy
          </div>
          <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-bone-300">
            Control Surface · v2
          </div>
        </div>
      </div>
    </div>
  );
}

function SystemStatus({
  health,
  error,
}: {
  health: HealthDetailed | undefined;
  error: string | undefined;
}): React.ReactElement {
  if (error !== undefined) {
    return (
      <div className="space-y-1.5 font-mono text-[10px] uppercase tracking-[0.16em]">
        <div className="flex items-center gap-2">
          <StatusDot tone="danger" />
          <span className="text-alert-500">proxy unreachable</span>
        </div>
      </div>
    );
  }
  if (health === undefined) {
    return (
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
        …connecting
      </div>
    );
  }
  return (
    <div className="space-y-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-bone-500">
      <div className="flex items-center gap-2">
        <StatusDot tone="phosphor" />
        <span className="text-bone-700">{health.status}</span>
      </div>
      <div>uptime · {formatUptime(health.uptime_seconds)}</div>
      <div>models · {health.models_count}</div>
      <div>providers · {health.providers_count}</div>
      {health.runtime.bun !== undefined ? <div>bun · {health.runtime.bun}</div> : null}
    </div>
  );
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}h ${mm}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
