import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeTransactionState,
  createTransactionState,
} from "../src/state.js";
import {
  cleanupExpiredSqliteTransactionState,
  createSqliteTransactionStateStorage,
} from "../src/storage/sqlite.js";

const dirs: string[] = [];
function newFile() {
  const dir = mkdtempSync(join(tmpdir(), "discourse-storage-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("Node SQLite transaction-state storage", () => {
  it("migrates its table and provides one atomic winner across connections", async () => {
    const path = newFile();
    const dbA = new DatabaseSync(path);
    const dbB = new DatabaseSync(path);
    const storageA = createSqliteTransactionStateStorage(dbA);
    const storageB = createSqliteTransactionStateStorage(dbB);
    const created = await createTransactionState(
      storageA,
      {
        operation: "sign-in",
        successURL: "https://app.example/done",
        errorURL: "https://app.example/error",
        trustedOrigins: ["https://app.example"],
        browserSecret: "browser",
        now: 1_000,
      },
      "integrity-key",
    );
    const results = await Promise.all([
      consumeTransactionState(
        storageA,
        { nonce: created.nonce, browserSecret: "browser", now: 1_001 },
        "integrity-key",
      ),
      consumeTransactionState(
        storageB,
        { nonce: created.nonce, browserSecret: "browser", now: 1_001 },
        "integrity-key",
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    dbA.close();
    dbB.close();
  });

  it("supports expiry cleanup without changing callback atomicity", async () => {
    const db = new DatabaseSync(newFile());
    const storage = createSqliteTransactionStateStorage(db);
    await createTransactionState(
      storage,
      {
        operation: "sign-in",
        successURL: "https://app.example/done",
        errorURL: "https://app.example/error",
        trustedOrigins: ["https://app.example"],
        browserSecret: "browser",
        now: 100,
        ttlMs: 10,
      },
      "integrity-key",
    );
    expect(cleanupExpiredSqliteTransactionState(db, 110)).toBe(1);
    expect(
      db.prepare("SELECT count(*) AS n FROM better_auth_discourse_state").get(),
    ).toMatchObject({ n: 0 });
    db.close();
  });
});
