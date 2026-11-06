import { createAuthEndpoint } from "better-auth/api";
import { getTestInstance } from "better-auth/test";
import { handleOAuthUserInfo, linkOAuthAccount } from "better-auth/oauth2";
import { setSessionCookie } from "better-auth/cookies";
import type { BetterAuthPlugin } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";

function compatibilityPlugin(): BetterAuthPlugin {
  return {
    id: "compat-test",
    endpoints: {
      provision: createAuthEndpoint(
        "/compat/provision",
        { method: "POST" },
        async (ctx) => {
          const db = ctx.context.internalAdapter;
          const key = { providerId: "discourse", accountId: "000042" };
          const existing = await db.findAccountByKey(key);
          if (existing)
            return ctx.json({
              userId: existing.userId,
              accountId: existing.accountId,
              existing: true,
            });

          const user = await db.createUser(
            {
              email: "provider@example.test",
              emailVerified: false,
              name: "Discourse Person",
            },
            {
              method: "oauth",
              oauth: {
                providerId: "discourse",
                profile: { handle: "stable-name" },
              },
            },
          );
          const account = await db.linkAccount({ ...key, userId: user.id });
          return ctx.json({
            userId: user.id,
            accountId: account.accountId,
            existing: false,
          });
        },
      ),
      createSession: createAuthEndpoint(
        "/compat/session",
        { method: "POST" },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: "session@example.test",
              emailVerified: false,
              name: "Session Person",
            },
            {
              method: "oauth",
              oauth: { providerId: "discourse", profile: {} },
            },
          );
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
          );
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ userId: user.id });
        },
      ),
      resolveOAuth: createAuthEndpoint(
        "/compat/resolve-oauth",
        { method: "POST" },
        async (ctx) => {
          const result = await handleOAuthUserInfo(ctx, {
            userInfo: {
              id: "oauth-subject",
              email: "collision@example.test",
              emailVerified: false,
              name: "Provider Profile",
            },
            account: {
              providerId: "discourse",
              accountId: "collision-subject",
            },
            source: {
              method: "oauth",
              oauth: { providerId: "discourse", profile: {} },
            },
          });
          return ctx.json({
            error: result.error,
            isRegister: "isRegister" in result ? result.isRegister : null,
          });
        },
      ),
      resolveTrustedOAuth: createAuthEndpoint(
        "/compat/resolve-trusted-oauth",
        { method: "POST" },
        async (ctx) => {
          const result = await handleOAuthUserInfo(ctx, {
            userInfo: {
              id: "trusted-subject",
              email: "trusted@example.test",
              emailVerified: true,
              name: "Trusted Profile",
            },
            account: { providerId: "discourse", accountId: "trusted-subject" },
            source: {
              method: "oauth",
              oauth: { providerId: "discourse", profile: {} },
            },
          });
          return ctx.json({
            error: result.error,
            registered: "isRegister" in result ? result.isRegister : null,
          });
        },
      ),
      explicitLink: createAuthEndpoint(
        "/compat/explicit-link",
        { method: "POST" },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: "explicit@example.test",
              emailVerified: false,
              name: "Original Name",
            },
            { method: "oauth", oauth: { providerId: "github", profile: {} } },
          );
          const result = await linkOAuthAccount(ctx, {
            link: { userId: user.id, email: user.email },
            userInfo: {
              email: user.email,
              emailVerified: false,
              name: "Changed Name",
            },
            account: { providerId: "discourse", accountId: "explicit-subject" },
            profile: { external_id: "explicit-subject" },
          });
          const updatedUser = await ctx.context.internalAdapter.findUserById(
            user.id,
          );
          return ctx.json({
            result,
            email: updatedUser?.email,
            verified: updatedUser?.emailVerified,
            name: updatedUser?.name,
          });
        },
      ),
      createWithAdditionalField: createAuthEndpoint(
        "/compat/additional-field",
        { method: "POST" },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: "field@example.test",
              emailVerified: false,
              name: "Before Hook",
              forumRole: "member",
              notDeclared: "should be discarded",
            },
            {
              method: "oauth",
              oauth: {
                providerId: "discourse",
                profile: { forumRole: "member" },
              },
            },
          );
          return ctx.json({
            name: user.name,
            forumRole: user.forumRole,
            notDeclared: user.notDeclared,
          });
        },
      ),
    },
  };
}

async function setup(options: Partial<BetterAuthOptions> = {}) {
  const instance = await getTestInstance({
    plugins: [compatibilityPlugin()],
    ...options,
  });
  return instance;
}

async function post(
  auth: { handler(request: Request): Promise<Response> },
  path: string,
) {
  return auth.handler(
    new Request(`http://localhost:3000/api/auth${path}`, { method: "POST" }),
  );
}

describe("Better Auth 1.7.18 public integration seams (SQLite)", () => {
  it("creates users/accounts through endpoint context and resolves by stable provider key", async () => {
    const { auth } = await setup();
    const first = await (await post(auth, "/compat/provision")).json();
    const second = await (await post(auth, "/compat/provision")).json();
    expect(first).toMatchObject({ accountId: "000042", existing: false });
    expect(second).toEqual({ ...first, existing: true });
  });

  it("keeps provider email unverified and rejects implicit linking on collision", async () => {
    const { auth } = await setup({
      account: {
        accountLinking: { enabled: true, disableImplicitLinking: false },
      },
    });
    const ctx = await auth.$context;
    await ctx.internalAdapter.createUser(
      {
        email: "collision@example.test",
        emailVerified: true,
        name: "Local Owner",
      },
      { method: "oauth", oauth: { providerId: "github", profile: {} } },
    );
    const result = await (await post(auth, "/compat/resolve-oauth")).json();
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(
      await ctx.internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: "collision-subject",
      }),
    ).toBeNull();
  });

  it("honors disableImplicitLinking even when provider and local email are verified", async () => {
    const { auth } = await setup({
      account: {
        accountLinking: {
          enabled: true,
          disableImplicitLinking: true,
          trustedProviders: ["discourse"],
        },
      },
    });
    const ctx = await auth.$context;
    await ctx.internalAdapter.createUser(
      { email: "trusted@example.test", emailVerified: true, name: "Local" },
      {
        method: "oauth",
        oauth: { providerId: "github", profile: {} },
      },
    );
    expect(
      await (await post(auth, "/compat/resolve-trusted-oauth")).json(),
    ).toMatchObject({
      error: "account not linked",
      registered: null,
    });
    expect(
      await ctx.internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: "trusted-subject",
      }),
    ).toBeNull();
  });

  it("creates a persisted Better Auth session and emits a cookie over HTTP", async () => {
    const { auth } = await setup();
    const response = await post(auth, "/compat/session");
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("better-auth.session_token=");
    const session = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie: cookie!.split(";")[0]! },
      }),
    );
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({
      user: { email: "session@example.test" },
    });
  });

  it("uses the exported explicit-link helper and preserves local email verification", async () => {
    const { auth } = await setup({
      account: {
        accountLinking: {
          enabled: true,
          updateUserInfoOnLink: true,
          trustedProviders: ["discourse"],
        },
      },
    });
    const response = await post(auth, "/compat/explicit-link");
    expect(await response.json()).toEqual({
      result: { linked: true },
      email: "explicit@example.test",
      verified: false,
      name: "Changed Name",
    });
    const disabled = await setup({
      account: { accountLinking: { enabled: false } },
    });
    expect(
      await (await post(disabled.auth, "/compat/explicit-link")).json(),
    ).toMatchObject({
      result: { linked: false },
      email: "explicit@example.test",
      verified: false,
    });
  });

  it("rejects linking a provider identity already owned by a different local user", async () => {
    const { auth } = await setup({
      account: {
        accountLinking: { enabled: true, trustedProviders: ["discourse"] },
      },
    });
    const adapter = (await auth.$context).internalAdapter;
    const owner = await adapter.createUser(
      { email: "owner@example.test", emailVerified: false, name: "Owner" },
      {
        method: "oauth",
        oauth: { providerId: "github", profile: {} },
      },
    );
    await adapter.linkAccount({
      providerId: "discourse",
      accountId: "explicit-subject",
      userId: owner.id,
    });
    const result = await (await post(auth, "/compat/explicit-link")).json();
    expect(result).toMatchObject({ result: { linked: false } });
    expect(
      await adapter.findAccountByKey({
        providerId: "discourse",
        accountId: "explicit-subject",
      }),
    ).toMatchObject({ userId: owner.id });
  });

  it("runs create hooks and accepts configured additional fields while dropping unknown fields", async () => {
    const { auth } = await setup({
      user: {
        additionalFields: {
          forumRole: { type: "string", required: false, input: false },
        },
      },
      databaseHooks: {
        user: {
          create: {
            before: async (user) => ({
              data: { ...user, name: `${user.name} (hook)` },
            }),
          },
        },
      },
    });
    const response = await post(auth, "/compat/additional-field");
    expect(await response.json()).toEqual({
      name: "Before Hook (hook)",
      forumRole: "member",
    });
  });

  it.fails(
    "does not guarantee exactly one winner for read-then-delete verification consumption",
    async () => {
      const { auth } = await setup();
      const adapter = (await auth.$context).internalAdapter;
      await adapter.createVerificationValue({
        identifier: "discourse-state:test",
        value: "payload",
        expiresAt: new Date(Date.now() + 60_000),
      });
      // Both callbacks can observe a still-valid record before either deletes it.
      const [callbackA, callbackB] = await Promise.all([
        adapter.findVerificationValue("discourse-state:test"),
        adapter.findVerificationValue("discourse-state:test"),
      ]);
      const claimed = [callbackA, callbackB].filter(
        (value) => value?.value === "payload",
      );
      expect(claimed).toHaveLength(1);
      await Promise.all([
        adapter.deleteVerificationByIdentifier("discourse-state:test"),
        adapter.deleteVerificationByIdentifier("discourse-state:test"),
      ]);
    },
  );
});
