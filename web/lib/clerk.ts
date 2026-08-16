"use client";

import { Clerk } from "@clerk/clerk-js";

const KEY_STORAGE = "mp_clerk_publishable_key";
let clerkPromise: Promise<Clerk> | undefined;

export function configureClerk(publishableKey: string): void {
  if (typeof window === "undefined" || publishableKey.trim().length === 0) return;
  window.localStorage.setItem(KEY_STORAGE, publishableKey.trim());
}

export async function getClerk(): Promise<Clerk | undefined> {
  if (typeof window === "undefined") return undefined;
  const key = window.localStorage.getItem(KEY_STORAGE);
  if (key === null || key.length === 0) return undefined;
  if (clerkPromise === undefined) {
    const clerk = new Clerk(key);
    clerkPromise = clerk.load().then(() => clerk);
  }
  return clerkPromise;
}

export async function getClerkToken(): Promise<string | undefined> {
  try {
    const clerk = await getClerk();
    return (await clerk?.session?.getToken()) ?? undefined;
  } catch {
    return undefined;
  }
}

export async function signOutClerk(): Promise<void> {
  const clerk = await getClerk();
  if (clerk?.session !== undefined) await clerk.signOut();
}

export async function mountClerkSignIn(element: HTMLDivElement): Promise<() => void> {
  const clerk = await getClerk();
  if (clerk === undefined) return () => {};
  clerk.mountSignIn(element, {
    routing: "hash",
    forceRedirectUrl: "/setup/",
  });
  return () => clerk.unmountSignIn(element);
}
