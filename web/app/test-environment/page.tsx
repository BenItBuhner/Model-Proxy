import { Suspense } from "react";
import { TestEnvironmentClient } from "./test-environment-client";

export default function TestEnvironmentPage(): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[40vh] items-center justify-center font-mono text-[11px] uppercase tracking-[0.2em] text-bone-300">
          loading…
        </div>
      }
    >
      <TestEnvironmentClient />
    </Suspense>
  );
}
