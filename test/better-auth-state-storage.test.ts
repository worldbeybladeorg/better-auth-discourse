import { createAuthEndpoint } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { describe, expect, it } from "vitest";
import {
  consumeTransactionState,
  createTransactionState,
  transactionStateSchema,
} from "../src/state.js";
import { createBetterAuthTransactionStateStorage } from "../src/storage/better-auth.js";

function statePlugin(): BetterAuthPlugin {
  return {
    id: "discourse-state-test",
    schema: transactionStateSchema,
    endpoints: {
      verifyAtomicity: createAuthEndpoint(
        "/state/test",
        { method: "POST" },
        async (ctx) => {
          const storage = createBetterAuthTransactionStateStorage(
            ctx.context.adapter,
          );
          const created = await createTransactionState(
            storage,
            {
              operation: "sign-in",
              successURL: "https://app.example/done",
              errorURL: "https://app.example/error",
              trustedOrigins: ["https://app.example"],
              browserSecret: "browser-secret",
            },
            "integrity-secret",
          );
          const wrongBinding = await consumeTransactionState(
            storage,
            {
              nonce: created.nonce,
              browserSecret: "wrong-browser",
            },
            "integrity-secret",
          );
          const contenders = await Promise.all([
            consumeTransactionState(
              storage,
              { nonce: created.nonce, browserSecret: "browser-secret" },
              "integrity-secret",
            ),
            consumeTransactionState(
              storage,
              { nonce: created.nonce, browserSecret: "browser-secret" },
              "integrity-secret",
            ),
          ]);
          return ctx.json({
            wrongBinding,
            winners: contenders.filter(Boolean).length,
            claimed: contenders.find(Boolean) ?? null,
          });
        },
      ),
      verifyExpiry: createAuthEndpoint(
        "/state/expiry",
        { method: "POST" },
        async (ctx) => {
          const storage = createBetterAuthTransactionStateStorage(
            ctx.context.adapter,
          );
          const created = await createTransactionState(
            storage,
            {
              operation: "sign-in",
              successURL: "https://app.example/done",
              errorURL: "https://app.example/error",
              trustedOrigins: ["https://app.example"],
              browserSecret: "browser-secret",
              now: 100,
              ttlMs: 5,
            },
            "integrity-secret",
          );
          const expired = await consumeTransactionState(
            storage,
            { nonce: created.nonce, browserSecret: "browser-secret", now: 105 },
            "integrity-secret",
          );
          return ctx.json({ expired });
        },
      ),
    },
  };
}

describe("Better Auth adapter transaction state storage (SQLite)", () => {
  it("fails closed when an adapter does not expose consumeOne", () => {
    expect(() =>
      createBetterAuthTransactionStateStorage({
        create: async () => ({}) as never,
      } as never),
    ).toThrow("UNSUPPORTED_BETTER_AUTH_STATE_ADAPTER");
  });

  it("uses plugin schema and atomically returns one conditional consume winner", async () => {
    const { auth } = await getTestInstance({ plugins: [statePlugin()] });
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/state/test", {
        method: "POST",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      wrongBinding: null,
      winners: 1,
      claimed: { operation: "sign-in" },
    });
  });

  it("does not consume an expired row", async () => {
    const { auth } = await getTestInstance({ plugins: [statePlugin()] });
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/state/expiry", {
        method: "POST",
      }),
    );
    expect(await response.json()).toEqual({ expired: null });
  });
});
