import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { afterEach, describe, expect, it } from "vitest";
import {
  consumeTransactionState,
  createTransactionState,
  transactionStateSchema,
  type StoredTransactionState,
  type TransactionStateStorage,
  validateDestination,
} from "../src/state.js";
import { createBetterAuthTransactionStateStorage } from "../src/storage/better-auth.js";

const dirs: string[] = [];
const databases: DatabaseSync[] = [];
async function openStorage(file: string) {
  const db = new DatabaseSync(file);
  databases.push(db);
  const options = {
    database: db,
    baseURL: "https://app.example.test",
    secret: "stable-state-test-secret-long-enough-for-validation",
    rateLimit: { enabled: false },
    plugins: [{ id: "discourse-state-test", schema: transactionStateSchema }],
  };
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);
  const { adapter } = await auth.$context;
  return {
    storage: createBetterAuthTransactionStateStorage(adapter),
    adapter,
  };
}
function file(): string {
  const dir = mkdtempSync(join(tmpdir(), "discourse-state-"));
  dirs.push(dir);
  return join(dir, "state.sqlite");
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
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

describe("persistent transaction state (Better Auth SQLite)", () => {
  it("binds browser, nonce, operation, destinations and expires exactly once", async () => {
    const path = file();
    const a = await openStorage(path);
    const b = await openStorage(path);
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
  });

  it("has one winner across independent database connections", async () => {
    const path = file();
    const first = await openStorage(path);
    const second = await openStorage(path);
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
  });

  it("rejects expired and absent state", async () => {
    const { storage, adapter } = await openStorage(file());
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
    expect(
      await adapter.findOne({
        model: "discourseConnectState",
        where: [{ field: "nonce", value: created.nonce }],
      }),
    ).toMatchObject({ nonce: created.nonce });
  });

  it("persists only a hash of the initiating session token and binds link context", async () => {
    const { storage } = await openStorage(file());
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
  });

  it("rejects destination tampering using the integrity key", async () => {
    const path = file();
    const { storage, adapter } = await openStorage(path);
    const created = await createTransactionState(
      storage,
      { ...input, browserSecret: "browser-secret" },
      "signing-key",
    );
    await adapter.update({
      model: "discourseConnectState",
      where: [{ field: "nonce", value: created.nonce }],
      update: { successURL: "https://evil.example/" },
    });
    expect(
      await consumeTransactionState(
        storage,
        { nonce: created.nonce, browserSecret: "browser-secret" },
        "signing-key",
      ),
    ).toBeNull();
  });

  it("rejects operation tampering using the integrity key", async () => {
    const path = file();
    const { storage, adapter } = await openStorage(path);
    const created = await createTransactionState(
      storage,
      { ...input, browserSecret: "browser-secret" },
      "signing-key",
    );
    await adapter.update({
      model: "discourseConnectState",
      where: [{ field: "nonce", value: created.nonce }],
      update: { operation: "link" },
    });
    expect(
      await consumeTransactionState(
        storage,
        { nonce: created.nonce, browserSecret: "browser-secret" },
        "signing-key",
      ),
    ).toBeNull();
  });

  it("revalidates storage hashes, operation and link fields at consumption", async () => {
    const { storage } = await openStorage(file());
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
  });

  it("rejects invalid lifetime values and sign-in records carrying link context", async () => {
    const { storage } = await openStorage(file());
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
