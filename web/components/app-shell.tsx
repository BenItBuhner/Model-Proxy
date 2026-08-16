"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearStoredApiKey } from "@/lib/api";
import { signOutClerk } from "@/lib/clerk";
import {
  authStatus,
  getMe,
  getHealth,
  logout as logoutRequest,
  type HealthDetailed,
  type PrincipalInfo,
} from "@/lib/endpoints";
import { StatusDot } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface NavItem {
  label: string;
  href: string;
  audience: "admin" | "user" | "all";
}

const THEME_STORAGE_KEY = "model-proxy.theme";
const THEME_OPTIONS = ["light", "dark", "system"] as const;

type ThemePreference = (typeof THEME_OPTIONS)[number];
type ResolvedTheme = Exclude<ThemePreference, "system">;

const NAV: NavItem[] = [
  { label: "Overview", href: "/", audience: "all" },
  { label: "Usage", href: "/usage", audience: "all" },
  { label: "Accounts", href: "/accounts", audience: "all" },
  { label: "Models", href: "/models", audience: "admin" },
  { label: "Providers", href: "/providers", audience: "admin" },
  { label: "Config", href: "/config", audience: "admin" },
  { label: "Test environment", href: "/test-environment", audience: "admin" },
  { label: "Observability", href: "/observability", audience: "admin" },
  { label: "Fusion", href: "/fusion", audience: "admin" },
  { label: "Proxies", href: "/proxies", audience: "admin" },
  { label: "Users", href: "/users", audience: "admin" },
  { label: "Invites", href: "/invites", audience: "admin" },
  { label: "Account", href: "/account", audience: "user" },
  { label: "Docs", href: "/docs", audience: "user" },
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

function isThemePreference(value: string | null): value is ThemePreference {
  return value !== null && (THEME_OPTIONS as readonly string[]).includes(value);
}

function readStoredThemePreference(): ThemePreference {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

function storeThemePreference(value: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures; the active theme still applies for this tab.
  }
}

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyThemePreference(preference: ThemePreference): void {
  const resolved = preference === "system" ? getSystemTheme() : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

export function AppShell({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname() ?? "/";
  const router = useRouter();
  const [health, setHealth] = useState<HealthDetailed | undefined>(undefined);
  const [healthErr, setHealthErr] = useState<string | undefined>(undefined);
  const [principal, setPrincipal] = useState<PrincipalInfo | undefined>(undefined);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [themePreference, setThemePreference] = useState<ThemePreference | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        await authStatus();
        const me = await getMe();
        const detail = await getHealth();
        if (!cancelled) setPrincipal(me.principal);
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

  useEffect(() => {
    setMobileNavOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileNavOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [mobileNavOpen]);

  useEffect(() => {
    setThemePreference(readStoredThemePreference());
  }, []);

  useEffect(() => {
    if (themePreference === undefined) return;

    applyThemePreference(themePreference);
    storeThemePreference(themePreference);

    if (themePreference !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: light)");
    const handleSystemThemeChange = (): void => applyThemePreference("system");

    media.addEventListener("change", handleSystemThemeChange);
    return () => media.removeEventListener("change", handleSystemThemeChange);
  }, [themePreference]);

  const handleLogout = async (): Promise<void> => {
    try {
      await logoutRequest();
    } catch {
      // ignore
    }
    await signOutClerk().catch(() => {});
    clearStoredApiKey();
    router.replace("/login");
  };

  return (
    <div className="min-h-screen">
      <MobileSiderail
        health={health}
        healthErr={healthErr}
        isOpen={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        onLogout={handleLogout}
        onThemePreferenceChange={setThemePreference}
        pathname={pathname}
        principal={principal}
        themePreference={themePreference ?? "system"}
      />
      <div className="mx-auto flex min-h-screen max-w-[1400px] flex-col px-4 py-4 lg:flex-row lg:px-6 lg:py-8">
        <header className="sticky top-0 z-40 -mx-4 mb-5 flex items-center justify-between border-b border-ink-500 bg-ink-900/95 px-4 py-3 backdrop-blur lg:hidden">
          <BrandMark />
          <button
            type="button"
            aria-controls="mobile-siderail"
            aria-expanded={mobileNavOpen}
            aria-label="Open navigation"
            onClick={() => setMobileNavOpen(true)}
            className="group inline-flex h-10 w-10 items-center justify-center border border-ink-300 bg-ink-700 text-bone-900 shadow-edge transition-colors hover:border-phosphor-500 hover:text-phosphor-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500"
          >
            <span className="sr-only">Open navigation</span>
            <span className="flex w-4 flex-col gap-1">
              <span className="h-px w-full bg-current transition-transform group-hover:translate-x-0.5" />
              <span className="h-px w-full bg-current" />
              <span className="h-px w-full bg-current transition-transform group-hover:-translate-x-0.5" />
            </span>
          </button>
        </header>
        <aside className="hidden w-[240px] shrink-0 lg:flex flex-col gap-8 pr-8">
          <SideRailContent
            health={health}
            healthErr={healthErr}
            onLogout={handleLogout}
            onThemePreferenceChange={setThemePreference}
            pathname={pathname}
            principal={principal}
            themePreference={themePreference ?? "system"}
          />
        </aside>

        <main className="flex-1 min-w-0 animate-flicker-in">
          {children}
        </main>
      </div>
    </div>
  );
}

function MobileSiderail({
  health,
  healthErr,
  isOpen,
  onClose,
  onLogout,
  onThemePreferenceChange,
  pathname,
  principal,
  themePreference,
}: {
  health: HealthDetailed | undefined;
  healthErr: string | undefined;
  isOpen: boolean;
  onClose: () => void;
  onLogout: () => void;
  onThemePreferenceChange: (next: ThemePreference) => void;
  pathname: string;
  principal: PrincipalInfo | undefined;
  themePreference: ThemePreference;
}): React.ReactElement {
  return (
    <div
      className={cn(
        "fixed inset-0 z-50 lg:hidden",
        isOpen ? "pointer-events-auto" : "pointer-events-none",
      )}
      aria-hidden={!isOpen}
      inert={isOpen ? undefined : true}
    >
      <button
        type="button"
        aria-label="Close navigation"
        onClick={onClose}
        className={cn(
          "absolute inset-0 bg-ink-900/75 transition-opacity duration-200",
          isOpen ? "opacity-100" : "opacity-0",
        )}
      />
      <aside
        id="mobile-siderail"
        role="dialog"
        aria-label="Navigation menu"
        aria-modal="true"
        className={cn(
          "absolute left-0 top-0 flex h-dvh w-[min(20rem,calc(100vw-2rem))] flex-col gap-8 border-r border-ink-300 bg-ink-850 px-6 py-6 shadow-[0_0_40px_rgba(0,0,0,0.55)] transition-transform duration-200 ease-out",
          isOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <SideRailContent
          action={
            <button
              type="button"
              aria-label="Close navigation"
              onClick={onClose}
              className="relative h-9 w-9 shrink-0 border border-ink-300 bg-ink-700 text-bone-900 shadow-edge transition-colors hover:border-phosphor-500 hover:text-phosphor-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500"
            >
              <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 rotate-45 bg-current" />
              <span className="absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-current" />
            </button>
          }
          health={health}
          healthErr={healthErr}
          onLogout={onLogout}
          onNavigate={onClose}
          onThemePreferenceChange={onThemePreferenceChange}
          pathname={pathname}
          principal={principal}
          themePreference={themePreference}
        />
      </aside>
    </div>
  );
}

function ThemeToggle({
  value,
  onChange,
}: {
  value: ThemePreference;
  onChange: (next: ThemePreference) => void;
}): React.ReactElement {
  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-300">
        theme
      </div>
      <div
        className="grid grid-cols-3 gap-1 bg-ink-800 p-1 shadow-edge"
        role="group"
        aria-label="Theme"
      >
        {THEME_OPTIONS.map((option) => {
          const active = option === value;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(option)}
              className={cn(
                "h-7 px-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-phosphor-500",
                active
                  ? "bg-phosphor-100 text-phosphor-500 shadow-edge-phosphor"
                  : "text-bone-500 hover:bg-ink-700 hover:text-bone-900",
              )}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SideRailContent({
  action,
  health,
  healthErr,
  onLogout,
  onNavigate,
  onThemePreferenceChange,
  pathname,
  principal,
  themePreference,
}: {
  action?: React.ReactNode;
  health: HealthDetailed | undefined;
  healthErr: string | undefined;
  onLogout: () => Promise<void> | void;
  onNavigate?: () => void;
  onThemePreferenceChange: (next: ThemePreference) => void;
  pathname: string;
  principal: PrincipalInfo | undefined;
  themePreference: ThemePreference;
}): React.ReactElement {
  const handleLogoutClick = (): void => {
    onNavigate?.();
    void onLogout();
  };
  const visibleNavItems = NAV.filter((item) => isVisibleNavItem(item, principal));

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <BrandMark />
        {action}
      </div>
      <nav className="flex flex-col gap-1">
        {visibleNavItems.map((item, index) => {
          const active = isNavActive(pathname, item);
          const code = String(index + 1).padStart(2, "0");
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
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
                  {code}
                </span>
                {item.label}
              </span>
              {active ? <span className="text-phosphor-500">›</span> : null}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-3 border-t border-ink-500 pt-4">
        <ThemeToggle value={themePreference} onChange={onThemePreferenceChange} />
        <SystemStatus health={health} error={healthErr} />
        <button
          type="button"
          onClick={handleLogoutClick}
          className="text-left font-mono text-[10px] uppercase tracking-[0.2em] text-bone-300 transition-colors hover:text-alert-500"
        >
          ← Sign out
        </button>
      </div>
    </>
  );
}

function isVisibleNavItem(item: NavItem, principal: PrincipalInfo | undefined): boolean {
  if (item.audience === "all") return true;
  if (principal === undefined) return false;
  const role = principal?.role;
  const isAdmin = principal?.isOwner === true || role === "owner" || role === "admin";
  return item.audience === "admin" ? isAdmin : !isAdmin;
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
