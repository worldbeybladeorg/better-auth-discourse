import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { describe, expect, it } from "vitest";
import { resolveDiscourseIdentity } from "../src/identity.js";
import type { DiscourseConnectClaims } from "../src/protocol.js";
import {
  createBetterAuthIdentityGuard,
  identityGuardSchema,
} from "../src/storage/identity.js";

const claims: DiscourseConnectClaims = {
  nonce: "hook-test",
  external_id: "hook-subject",
  email: "hook@example.test",
  username: "hook-user",
  name: "Hook User",
};

function plugin(): BetterAuthPlugin {
  return {
    id: "hook-failure-test",
    schema: identityGuardSchema,
    endpoints: {
      resolve: createAuthEndpoint(
        "/identity-hook-test",
        { method: "POST" },
        async (ctx) => {
          const result = await resolveDiscourseIdentity(ctx, claims, {
            disableSignUp: false,
            overrideUserInfoOnSignIn: true,
            identityLockStorage: createBetterAuthIdentityGuard(
              ctx.context.adapter,
            ),
          });
          return ctx.json(result);
        },
      ),
    },
  };
}

async function setup(overrides: Partial<BetterAuthOptions> = {}) {
  // A standalone persistent adapter avoids getTestInstance's cleanup/transaction
  // lifecycle, so assertions below observe committed state after failed requests.
  const database = new DatabaseSync(":memory:");
  const options: BetterAuthOptions = {
    database,
    secret: "stable-hook-failure-test-secret-long-enough",
    baseURL: "http://localhost:3000",
    rateLimit: { enabled: false },
    plugins: [plugin()],
    ...overrides,
  };
  const require = createRequire(import.meta.url);
  const betterAuthDist = dirname(require.resolve("better-auth"));
  const { getMigrations } = await import(
    pathToFileURL(join(betterAuthDist, "db/get-migration.mjs")).href
  );
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const auth = betterAuth(options);
  const context = await auth.$context;
  const response = () =>
    auth.handler(
      new Request("http://localhost:3000/api/auth/identity-hook-test", {
        method: "POST",
      }),
    );
  return { auth, context, database, response };
}

async function expectRejectedWithoutSession(response: Response) {
  expect(response.headers.get("set-cookie") ?? "").not.toContain(
    "session_token",
  );
  if (response.status < 400)
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
}

function remainingGuards(database: DatabaseSync) {
  return database
    .prepare('SELECT COUNT(*) AS count FROM "discourseIdentityGuard"')
    .get();
}

describe("identity behavior when Better Auth user hooks fail", () => {
  it("does not authenticate after a rejecting create hook and releases durable guards", async () => {
    const { context, database, response } = await setup({
      databaseHooks: {
        user: {
          create: {
            before: async () => {
              throw new Error("create hook rejected");
            },
          },
        },
      },
    });

    const result = await response();
    await expectRejectedWithoutSession(result);
    expect(
      await context.internalAdapter.findUserByEmail(claims.email),
    ).toBeNull();
    expect(
      await context.internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: claims.external_id,
      }),
    ).toBeNull();
    expect(remainingGuards(database)).toMatchObject({ count: 0 });
    database.close();
  });

  it("does not authenticate after a rejected update hook and releases durable guards", async () => {
    const { context, database, response } = await setup({
      databaseHooks: {
        user: {
          update: {
            before: async () => {
              throw new Error("update hook rejected");
            },
          },
        },
      },
    });
    const owner = await context.internalAdapter.createUser(
      { email: claims.email, emailVerified: false, name: "Before" },
      {
        method: "oauth",
        oauth: { providerId: "github", profile: {} },
      },
    );
    await context.internalAdapter.linkAccount({
      providerId: "discourse",
      accountId: claims.external_id,
      userId: owner.id,
    });

    const result = await response();
    await expectRejectedWithoutSession(result);
    expect(await context.internalAdapter.findUserById(owner.id)).toMatchObject({
      name: "Before",
    });
    expect(
      await context.internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: claims.external_id,
      }),
    ).toMatchObject({ userId: owner.id });
    expect(remainingGuards(database)).toMatchObject({ count: 0 });
    database.close();
  });

  it("does not create or authenticate an identity when a required mapped field is missing", async () => {
    const { context, database, response } = await setup({
      user: {
        additionalFields: { tenantCode: { type: "string", required: true } },
      },
    });

    const result = await response();
    await expectRejectedWithoutSession(result);
    expect(
      await context.internalAdapter.findUserByEmail(claims.email),
    ).toBeNull();
    expect(
      await context.internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: claims.external_id,
      }),
    ).toBeNull();
    expect(remainingGuards(database)).toMatchObject({ count: 0 });
    database.close();
  });
});
