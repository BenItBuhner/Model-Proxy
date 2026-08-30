"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function FusionRedirect(): React.ReactElement {
  const router = useRouter();
  useEffect(() => {
    router.replace("/usage?model=fusion-beta");
  }, [router]);
  return (
    <div className="flex min-h-[40vh] items-center justify-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
      moved to /usage?model=fusion-beta …
    </div>
  );
}
