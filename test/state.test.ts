import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeTransactionState,
  createTransactionState,
  type StoredTransactionState,
  type TransactionStateStorage,
  validateDestination,
} from "../src/state.js";

const dirs: string[] = [];
function openStorage(file: string): {
  storage: TransactionStateStorage;
  close: () => void;
} {
  const db = new Database(file);
  db.exec(`CREATE TABLE IF NOT EXISTS transaction_state (
    state_hash TEXT PRIMARY KEY, browser_binding_hash TEXT NOT NULL, nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL, operation TEXT NOT NULL, success_url TEXT NOT NULL,
    error_url TEXT NOT NULL, initiating_user_id TEXT, initiating_session_id TEXT,
    initiating_session_token_hash TEXT, integrity TEXT NOT NULL
  )`);
  const insert = db.prepare(`INSERT INTO transaction_state VALUES
    (@stateHash,@browserBindingHash,@nonce,@expiresAt,@operation,@successURL,@errorURL,
     @initiatingUserId,@initiatingSessionId,@initiatingSessionTokenHash,@integrity)`);
  const consume = db.prepare(`DELETE FROM transaction_state
    WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ? RETURNING *`);
  return {
    storage: {
      async insert(s: StoredTransactionState) {
        insert.run({
          stateHash: s.stateHash,
          browserBindingHash: s.browserBindingHash,
          nonce: s.nonce,
          expiresAt: s.expiresAt,
          operation: s.operation,
          successURL: s.successURL,
          errorURL: s.errorURL,
          initiatingUserId: s.initiatingUserId ?? null,
          initiatingSessionId: s.initiatingSessionId ?? null,
          initiatingSessionTokenHash: s.initiatingSessionTokenHash ?? null,
          integrity: s.integrity,
        });
      },
      async consume(input) {
        const row = consume.get(
          input.stateHash,
          input.browserBindingHash,
          input.now,
        ) as Record<string, unknown> | undefined;
        if (!row) return null;
        return {
          stateHash: row.state_hash,
          browserBindingHash: row.browser_binding_hash,
          nonce: row.nonce,
          expiresAt: row.expires_at,
          operation: row.operation,
          successURL: row.success_url,
          errorURL: row.error_url,
          initiatingUserId: row.initiating_user_id ?? undefined,
          initiatingSessionId: row.initiating_session_id ?? undefined,
          initiatingSessionTokenHash:
            row.initiating_session_token_hash ?? undefined,
          integrity: row.integrity,
        } as StoredTransactionState;
      },
    },
    close: () => db.close(),
  };
}
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "discourse-state-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const policy = { trustedOrigins: ["https://app.example.test"] };
const input = {
  operation: "sign-in" as const,
  successURL: "https://app.example.test/done",
  errorURL: "https://app.example.test/error",
  ...policy,
};

describe("persistent transaction state", () => {
  it("binds browser, nonce, operation, destinations and expires exactly once", async () => {
    const path = file();
    const a = openStorage(path);
    const b = openStorage(path);
    const created = await createTransactionState(
      a.storage,
      { ...input, browserSecret: "browser-secret", now: 10_000, ttlMs: 100 },
      "signing-key",
    );
    expect(
      await consumeTransactionState(
        b.storage,
        { nonce: created.nonce, browserSecret: "wrong", now: 10_020 },
        "signing-key",
      ),
    ).toBeNull();
    const claimed = await consumeTransactionState(
      b.storage,
      { nonce: created.nonce, browserSecret: "browser-secret", now: 10_020 },
      "signing-key",
    );
    expect(claimed).toMatchObject({
      operation: "sign-in",
      successURL: "https://app.example.test/done",
      errorURL: "https://app.example.test/error",
    });
    expect(
      await consumeTransactionState(
        a.storage,
        { nonce: created.nonce, browserSecret: "browser-secret", now: 10_030 },
        "signing-key",
      ),
    ).toBeNull();
    a.close();
    b.close();
  });

  it("has one winner across independent database connections", async () => {
    const path = file();
    const first = openStorage(path);
    const second = openStorage(path);
    const created = await createTransactionState(
      first.storage,
      { ...input, browserSecret: "browser-secret" },
      "signing-key",
    );
    const results = await Promise.all([
      consumeTransactionState(
        first.storage,
        { nonce: created.nonce, browserSecret: "browser-secret" },
        "signing-key",
      ),
      consumeTransactionState(
        second.storage,
        { nonce: created.nonce, browserSecret: "browser-secret" },
        "signing-key",
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    first.close();
    second.close();
  });

  it("rejects expired and absent state", async () => {
    const { storage, close } = openStorage(file());
    const created = await createTransactionState(
      storage,
      { ...input, browserSecret: "browser-secret", now: 100, ttlMs: 5 },
      "signing-key",
    );
    expect(
      await consumeTransactionState(
        storage,
        { nonce: created.nonce, browserSecret: "browser-secret", now: 105 },
        "signing-key",
      ),
    ).toBeNull();
    expect(
      await consumeTransactionState(
        storage,
        { nonce: "absent", browserSecret: "browser-secret" },
        "signing-key",
      ),
    ).toBeNull();
    close();
  });

  it("persists only a hash of the initiating session token and binds link context", async () => {
    const { storage, close } = openStorage(file());
    const created = await createTransactionState(
      storage,
      {
        ...input,
        operation: "link",
        browserSecret: "browser-secret",
        initiatingUserId: "u1",
        initiatingSessionId: "s1",
        initiatingSessionToken: "bearer",
      },
      "signing-key",
    );
    const value = await consumeTransactionState(
      storage,
      { nonce: created.nonce, browserSecret: "browser-secret" },
      "signing-key",
    );
    expect(value).toMatchObject({
      operation: "link",
      initiatingUserId: "u1",
      initiatingSessionId: "s1",
    });
    expect(value?.initiatingSessionTokenHash).not.toBe("bearer");
    close();
  });

  it("rejects destination tampering using the integrity key", async () => {
    const path = file();
    const { storage, close } = openStorage(path);
    const created = await createTransactionState(
      storage,
      { ...input, browserSecret: "browser-secret" },
      "signing-key",
    );
    const db = new Database(path);
    db.prepare("UPDATE transaction_state SET success_url = ?").run(
      "https://evil.example/",
    );
    db.close();
    expect(
      await consumeTransactionState(
        storage,
        { nonce: created.nonce, browserSecret: "browser-secret" },
        "signing-key",
      ),
    ).toBeNull();
    close();
  });

  it("rejects operation tampering using the integrity key", async () => {
    const path = file();
    const { storage, close } = openStorage(path);
    const created = await createTransactionState(
      storage,
      { ...input, browserSecret: "browser-secret" },
      "signing-key",
    );
    const db = new Database(path);
    db.prepare("UPDATE transaction_state SET operation = ?").run("link");
    db.close();
    expect(
      await consumeTransactionState(
        storage,
        { nonce: created.nonce, browserSecret: "browser-secret" },
        "signing-key",
      ),
    ).toBeNull();
    close();
  });

  it("revalidates storage hashes, operation and link fields at consumption", async () => {
    const { storage, close } = openStorage(file());
    const created = await createTransactionState(
      storage,
      { ...input, browserSecret: "browser-secret" },
      "signing-key",
    );
    const malformed: TransactionStateStorage = {
      insert: (state) => storage.insert(state),
      consume: async (args) => {
        const row = await storage.consume(args);
        return row
          ? {
              ...row,
              browserBindingHash: "tampered",
              operation: "bogus" as StoredTransactionState["operation"],
            }
          : null;
      },
    };
    expect(
      await consumeTransactionState(
        malformed,
        { nonce: created.nonce, browserSecret: "browser-secret" },
        "signing-key",
      ),
    ).toBeNull();
    close();
  });

  it("rejects invalid lifetime values and sign-in records carrying link context", async () => {
    const { storage, close } = openStorage(file());
    for (const ttlMs of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      60 * 60_000 + 1,
    ]) {
      await expect(
        createTransactionState(storage, { ...input, ttlMs }, "signing-key"),
      ).rejects.toThrow("INVALID_STATE_LIFETIME");
    }
    await expect(
      createTransactionState(
        storage,
        { ...input, now: Number.NaN },
        "signing-key",
      ),
    ).rejects.toThrow("INVALID_STATE_LIFETIME");
    await expect(
      createTransactionState(
        storage,
        { ...input, initiatingUserId: "user" },
        "signing-key",
      ),
    ).rejects.toThrow("INVALID_LINK_SESSION");
    close();
  });

  it("validates destinations with the reusable origin policy", () => {
    expect(validateDestination("/relative", policy)).toBe("/relative");
    for (const url of [
      "//evil.test/path",
      "/\\evil.test/path",
      "/\n/evil.test",
      "/\t/evil.test",
      "/\r/evil.test",
      "https://evil.test/\n@app.example.test",
      "https://app.example.test\\@evil.test",
      "javascript:alert(1)",
      "https://user:pass@app.example.test/x",
      "https://evil.test/x",
    ]) {
      expect(() => validateDestination(url, policy)).toThrow(
        "INVALID_DESTINATION",
      );
    }
    expect(validateDestination("https://app.example.test/path", policy)).toBe(
      "https://app.example.test/path",
    );
  });
});
