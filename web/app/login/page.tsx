"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  ApiException,
  getStoredApiKey,
  setStoredApiKey,
  clearStoredApiKey,
} from "@/lib/api";
import { authStatus, login } from "@/lib/endpoints";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { StatusDot } from "@/components/ui/badge";

export default function LoginPage(): React.ReactElement {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [key, setKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const stored = getStoredApiKey();
    if (stored === undefined) {
      inputRef.current?.focus();
      return;
    }
    authStatus()
      .then((result) => {
        if (cancelled) return;
        if (result.authenticated) router.replace("/");
        else inputRef.current?.focus();
      })
      .catch(() => {
        if (cancelled) return;
        inputRef.current?.focus();
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(undefined);
    setSubmitting(true);
    setStoredApiKey(key.trim());
    try {
      await login(key.trim());
      router.replace("/");
    } catch (err) {
      clearStoredApiKey();
      if (err instanceof ApiException) setError(err.message);
      else setError("Unknown error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-[440px] animate-flicker-in">
        <div className="mb-10 space-y-3 text-center">
          <div className="mx-auto h-8 w-8 bg-phosphor-500 shadow-[0_0_24px_rgba(205,255,0,0.65)]" />
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-bone-300">
            model / proxy · control surface
          </div>
          <h1 className="font-mono text-2xl tracking-tight text-bone-900">
            Request session
          </h1>
          <p className="mx-auto max-w-[36ch] text-sm text-bone-500">
            Authenticate with the <code className="text-phosphor-500">CLIENT_API_KEY</code> defined on your
            proxy. The key is held locally in your browser and exchanged for an
            http-only session cookie.
          </p>
        </div>
        <div className="corners relative bg-ink-800 shadow-edge">
          <form onSubmit={handleSubmit} className="space-y-6 p-6">
            <div>
              <Label htmlFor="api-key" hint="paste then press enter">
                API Key
              </Label>
              <Input
                id="api-key"
                ref={inputRef}
                type="password"
                autoComplete="current-password"
                monospace
                placeholder="sk_…"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                disabled={submitting}
              />
            </div>

            {error !== undefined ? (
              <div className="flex items-start gap-2 font-mono text-[11px] text-alert-500">
                <StatusDot tone="danger" />
                <span>{error}</span>
              </div>
            ) : null}

            <Button
              type="submit"
              size="lg"
              disabled={submitting || key.trim().length === 0}
              className="w-full"
            >
              {submitting ? "verifying…" : "enter control surface"}
            </Button>

            <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-[0.18em] text-bone-300">
              <span>zero telemetry</span>
              <span>local only</span>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
