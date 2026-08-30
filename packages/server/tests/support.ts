import { rmSync } from "node:fs";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";

function sleepSync(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy-wait: teardown hooks are synchronous
  }
}

/**
 * rmSync that tolerates transient Windows file locks (EBUSY/EPERM/ENOTEMPTY)
 * from antivirus/indexing on freshly written files, and releases the open
 * SQLite handle (the operational DB lives under the storage tree that tests
 * delete between cases; Windows cannot delete open files).
 */
export function rmWithRetry(
  path: string,
  options: { recursive?: boolean; force?: boolean } | number = {},
  attempts = 6,
): void {
  const maxAttempts = typeof options === "number" ? options : attempts;
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!retryable || attempt >= maxAttempts) throw err;
      closeOperationalDbForTests();
      sleepSync(40 * attempt);
    }
  }
}
