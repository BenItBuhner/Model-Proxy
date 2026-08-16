import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createAccount } from "../src/storage/account-store.ts";
import {
  getConvexMirrorStatus,
  resetConvexMirrorForTests,
  startConvexMirror,
} from "../src/storage/convex-mirror.ts";
import { closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const root = join(tmpdir(), `mp-convex-mirror-${process.pid}-${Date.now()}`);
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(() => {
  rmSync(root, { recursive: true, force: true });
  setStorageRootForTests(root);
  closeOperationalDbForTests();
  resetConvexMirrorForTests();
});

afterEach(() => {
  server?.stop(true);
  server = undefined;
  delete process.env.CONVEX_URL;
  delete process.env.CONVEX_SYNC_SECRET;
  resetConvexMirrorForTests();
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("Convex provider account mirror", () => {
  test("sends only encrypted credential fields", async () => {
    let mutationBody: Record<string, unknown> | undefined;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        mutationBody = (await request.json()) as Record<string, unknown>;
        return Response.json({
          status: "success",
          value: { upserted: 1, removed: 0 },
        });
      },
    });
    process.env.CONVEX_URL = `http://127.0.0.1:${server.port}`;
    process.env.CONVEX_SYNC_SECRET = "test-sync-secret-at-least-24-characters";
    createAccount({
      provider: "codex",
      kind: "oauth",
      accessToken: "plaintext-access",
      refreshToken: "plaintext-refresh",
      shared: true,
    });
    startConvexMirror();
    await Bun.sleep(1_000);

    expect(mutationBody?.["path"]).toBe("providerAccounts:reconcile");
    const serialized = JSON.stringify(mutationBody);
    expect(serialized).toContain("enc:v1:");
    expect(serialized).not.toContain("plaintext-access");
    expect(serialized).not.toContain("plaintext-refresh");
    expect(getConvexMirrorStatus()).toMatchObject({
      configured: true,
      syncing: false,
      accountCount: 1,
      lastError: undefined,
    });
  });
});
