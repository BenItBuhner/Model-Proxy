import { rmWithRetry } from "./support.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeOperationalDbForTests,
} from "../src/storage/operational-db.ts";
import {
  resetGlobalResponseStoreForTests,
  type StoredResponseEntry,
} from "../src/format/response-store.ts";
import { setStorageRootForTests } from "../src/storage/storage-paths.ts";

describe("persistent Responses response store", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mp-response-store-"));
    setStorageRootForTests(root);
    closeOperationalDbForTests();
  });

  afterEach(() => {
    closeOperationalDbForTests();
    setStorageRootForTests(undefined);
    rmWithRetry(root, { recursive: true, force: true });
  });

  function entry(id: string, ownerId: string): StoredResponseEntry {
    return {
      id,
      ownerId,
      model: "glm-5.2",
      createdAt: Math.floor(Date.now() / 1000),
      status: "completed",
      messages: [{ role: "user", content: "hello" }],
      inputItems: [{ type: "message", role: "user", content: "hello" }],
      response: { id, object: "response", output: [] },
      store: true,
    };
  }

  test("survives a process-local cache reset", () => {
    const first = resetGlobalResponseStoreForTests();
    first.set(entry("resp_persisted", "user-a"));

    const second = resetGlobalResponseStoreForTests();
    expect(second.get("resp_persisted", "user-a")?.response.id).toBe("resp_persisted");
    expect(second.get("resp_persisted", "user-a")?.inputItems).toHaveLength(1);
  });

  test("enforces owner isolation", () => {
    const store = resetGlobalResponseStoreForTests();
    store.set(entry("resp_private", "user-a"));
    expect(store.get("resp_private", "user-b")).toBeUndefined();
    expect(store.get("resp_private", "user-a")).toBeDefined();
  });

  test("delete removes the persistent record", () => {
    const store = resetGlobalResponseStoreForTests();
    store.set(entry("resp_delete", "user-a"));
    store.delete("resp_delete", "user-a");
    expect(resetGlobalResponseStoreForTests().get("resp_delete", "user-a")).toBeUndefined();
  });
});
