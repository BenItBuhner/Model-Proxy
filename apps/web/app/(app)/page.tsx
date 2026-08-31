"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function OverviewRedirect(): React.ReactElement {
  const router = useRouter();
  useEffect(() => {
    router.replace("/account");
  }, [router]);
  return (
    <div className="flex min-h-[40vh] items-center justify-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
      moving to your account …
    </div>
  );
}
