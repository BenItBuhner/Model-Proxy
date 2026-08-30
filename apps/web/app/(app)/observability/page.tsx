"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function ObservabilityRedirect(): React.ReactElement {
  const router = useRouter();
  useEffect(() => {
    router.replace("/usage");
  }, [router]);
  return (
    <div className="flex min-h-[40vh] items-center justify-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
      moved to /usage …
    </div>
  );
}
