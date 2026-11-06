import { createAuthEndpoint } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import {
  createBetterAuthIdentityGuard,
  identityGuardSchema,
} from "../src/storage/identity.js";

function lockPlugin(): BetterAuthPlugin {
  return {
    id: "identity-lock-test",
    schema: identityGuardSchema,
    endpoints: {
      contend: createAuthEndpoint(
        "/identity-lock/contend",
        { method: "POST" },
        async (ctx) => {
          const a = createBetterAuthIdentityGuard(ctx.context.adapter);
          const b = createBetterAuthIdentityGuard(ctx.context.adapter);
          const events: string[] = [];
          await Promise.all([
            a.withLocks(["account:discourse:subject"], async () => {
              events.push("first-enter");
              await new Promise((resolve) => setTimeout(resolve, 20));
              events.push("first-exit");
            }),
            b.withLocks(["account:discourse:subject"], async () => {
              events.push("second-enter");
              events.push("second-exit");
            }),
          ]);
          return ctx.json({
            events,
            remaining: await ctx.context.adapter.findOne({
              model: "discourseIdentityGuard",
              where: [{ field: "lockKey", value: "account:discourse:subject" }],
            }),
          });
        },
      ),
    },
  };
}

describe("Better Auth durable identity guard storage (SQLite)", () => {
  it("serializes independent guard instances through unique create and atomic owner-checked consume", async () => {
    const { auth } = await getTestInstance({ plugins: [lockPlugin()] });
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/identity-lock/contend", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      events: ["first-enter", "first-exit", "second-enter", "second-exit"],
      remaining: null,
    });
  });

  it("fails closed when the exposed adapter is missing atomic guard methods", () => {
    expect(() =>
      createBetterAuthIdentityGuard({ create: async () => ({}) } as never),
    ).toThrow("UNSUPPORTED_BETTER_AUTH_IDENTITY_GUARD_ADAPTER");
  });

  it("attempts every owner-matched release when one consume fails", async () => {
    const rows = new Map<string, { lockKey: string; ownerToken: string }>();
    let consumes = 0;
    const adapter = {
      async create<T>({
        data,
      }: {
        model: string;
        data: Record<string, unknown>;
      }): Promise<T> {
        const key = data.lockKey as string;
        if (rows.has(key)) throw new Error("UNIQUE lockKey");
        rows.set(key, { lockKey: key, ownerToken: data.ownerToken as string });
        return {} as T;
      },
      async findOne<T>({
        where,
      }: {
        model: string;
        where: Array<{ field: string; value: string | number }>;
      }): Promise<T | null> {
        const row = rows.get(where[0]!.value as string);
        return (row ?? null) as T | null;
      },
      async consumeOne<T>({
        where,
      }: {
        model: string;
        where: Array<{ field: string; value: string | number }>;
      }): Promise<T | null> {
        consumes++;
        if (consumes === 1) throw new Error("temporary consume failure");
        const key = where[0]!.value as string;
        const row = rows.get(key);
        if (row?.ownerToken !== where[1]!.value) return null;
        rows.delete(key);
        return row as T;
      },
    };
    const guard = createBetterAuthIdentityGuard(adapter);
    await expect(
      guard.withLocks(["a", "b"], async () => "done"),
    ).rejects.toThrow("temporary consume failure");
    expect(consumes).toBe(2);
    expect(rows.size).toBe(1); // failed delete remains fail-closed, the second lock was still released
    expect([...rows.keys()]).toEqual(["b"]);
  });

  it("releases every lock when the protected identity operation fails", async () => {
    const rows = new Map<string, { lockKey: string; ownerToken: string }>();
    const adapter = {
      async create<T>({
        data,
      }: {
        model: string;
        data: Record<string, unknown>;
      }): Promise<T> {
        const key = data.lockKey as string;
        if (rows.has(key)) throw new Error("unique lock");
        const row = { lockKey: key, ownerToken: data.ownerToken as string };
        rows.set(key, row);
        return row as T;
      },
      async findOne<T>({
        where,
      }: {
        model: string;
        where: Array<{ field: string; value: string | number }>;
      }): Promise<T | null> {
        return (rows.get(where[0]!.value as string) ?? null) as T | null;
      },
      async consumeOne<T>({
        where,
      }: {
        model: string;
        where: Array<{ field: string; value: string | number }>;
      }): Promise<T | null> {
        const key = where[0]!.value as string;
        const row = rows.get(key);
        if (row?.ownerToken !== where[1]!.value) return null;
        rows.delete(key);
        return row as T;
      },
    };
    const guard = createBetterAuthIdentityGuard(adapter);
    await expect(
      guard.withLocks(
        ["account:discourse:subject", "email:person@example.test"],
        async () => {
          throw new Error("host database hook rejected identity");
        },
      ),
    ).rejects.toThrow("host database hook rejected identity");
    expect(rows.size).toBe(0);
  });

  it("fails immediately on a non-uniqueness acquisition error and releases earlier locks", async () => {
    const rows = new Map<string, { lockKey: string; ownerToken: string }>();
    let lookups = 0;
    const adapter = {
      async create<T>({
        data,
      }: {
        model: string;
        data: Record<string, unknown>;
      }): Promise<T> {
        if (data.lockKey === "b") throw new Error("database unavailable");
        const row = {
          lockKey: data.lockKey as string,
          ownerToken: data.ownerToken as string,
        };
        rows.set(row.lockKey, row);
        return row as T;
      },
      async findOne<T>(): Promise<T | null> {
        lookups++;
        return { lockKey: "b" } as T;
      },
      async consumeOne<T>({
        where,
      }: {
        model: string;
        where: Array<{ field: string; value: string | number }>;
      }): Promise<T | null> {
        const row = rows.get(where[0]!.value as string);
        if (row?.ownerToken !== where[1]!.value) return null;
        rows.delete(row.lockKey);
        return row as T;
      },
    };
    await expect(
      createBetterAuthIdentityGuard(adapter).withLocks(
        ["a", "b"],
        async () => undefined,
      ),
    ).rejects.toThrow("database unavailable");
    expect(lookups).toBe(0);
    expect(rows.size).toBe(0);
  });
});
