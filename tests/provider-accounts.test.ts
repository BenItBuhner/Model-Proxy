import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  accountRef,
  createAccount,
  getAccount,
  listActiveAccounts,
  principalCanManageAccount,
  principalCanUseAccount,
} from "../src/storage/account-store.ts";
import { createUser, type Principal } from "../src/storage/identity-store.ts";
import { getOperationalDb, closeOperationalDbForTests } from "../src/storage/operational-db.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

const root = join(tmpdir(), `mp-provider-accounts-${process.pid}-${Date.now()}`);

beforeEach(() => {
  setStorageRootForTests(root);
  closeOperationalDbForTests();
  rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  closeOperationalDbForTests();
  setStorageRootForTests(undefined);
  rmSync(root, { recursive: true, force: true });
});

describe("provider account store", () => {
  test("encrypts credentials at rest and decrypts only when read", () => {
    const account = createAccount({
      provider: "codex",
      kind: "oauth",
      label: "Work ChatGPT",
      accessToken: "access-super-secret",
      refreshToken: "refresh-super-secret",
      shared: true,
    });
    const row = getOperationalDb()
      .query(
        "SELECT access_token, refresh_token FROM provider_accounts WHERE id = $id",
      )
      .get({ $id: account.id }) as {
      access_token: string;
      refresh_token: string;
    };
    expect(row.access_token).toStartWith("enc:v1:");
    expect(row.refresh_token).toStartWith("enc:v1:");
    expect(row.access_token).not.toContain("access-super-secret");
    expect(getAccount(account.id)?.accessToken).toBe("access-super-secret");
    expect(accountRef(account.id)).toBe(`account:${account.id}`);
  });

  test("enforces personal, shared, and admin account eligibility", () => {
    const storedUserA = createUser({
      email: "user-a@example.com",
      password: "correct-horse",
    });
    const personal = createAccount({
      provider: "codex",
      kind: "token",
      accessToken: "personal",
      ownerUserId: storedUserA.id,
    });
    const shared = createAccount({
      provider: "codex",
      kind: "token",
      accessToken: "shared",
      ownerUserId: storedUserA.id,
      shared: true,
    });
    const userA = principal(storedUserA.id, "user");
    const userB = principal("user-b", "user");
    const admin = principal("admin", "owner");

    expect(principalCanUseAccount(userA, personal)).toBe(true);
    expect(principalCanUseAccount(userB, personal)).toBe(false);
    expect(principalCanUseAccount(userB, shared)).toBe(true);
    expect(principalCanManageAccount(userB, shared)).toBe(false);
    expect(principalCanManageAccount(admin, personal)).toBe(true);
    expect(listActiveAccounts("codex")).toHaveLength(2);
  });
});

function principal(userId: string, role: "owner" | "user"): Principal {
  return {
    id: userId,
    userId,
    apiKeyId: undefined,
    email: `${userId}@example.com`,
    role,
    isOwner: role === "owner",
    scopes: ["*"],
    authMethod: "session",
    ownerBypass: role === "owner",
    completionLoggingEnabled: false,
  };
}
