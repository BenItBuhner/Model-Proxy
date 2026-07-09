"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { useState } from "react";
import { apiFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

export default function SignupPage(): React.ReactElement {
  return (
    <Suspense fallback={<main className="flex min-h-screen items-center justify-center">Loading signup…</main>}>
      <SignupForm />
    </Suspense>
  );
}

function SignupForm(): React.ReactElement {
  const router = useRouter();
  const search = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    try {
      await apiFetch("/v1/auth/signup", {
        method: "POST",
        body: {
          email,
          password,
          invite_token: search.get("invite_token") ?? undefined,
        },
      });
      router.replace("/account");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center px-6 py-12">
      <form onSubmit={(event) => void submit(event)} className="corners w-full max-w-[440px] space-y-5 bg-ink-800 p-6 shadow-edge">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-bone-300">model / proxy</div>
          <h1 className="mt-2 font-mono text-2xl text-bone-900">Create account</h1>
        </div>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" value={email} onChange={(event) => setEmail(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        {error !== undefined ? <div className="text-sm text-alert-500">{error}</div> : null}
        <Button type="submit" className="w-full">create account</Button>
      </form>
    </main>
  );
}
