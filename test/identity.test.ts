import { createAuthEndpoint } from "better-auth/api";
import { getTestInstance } from "better-auth/test";
import { parseAdditionalUserInputFromProviderProfile } from "better-auth/db";
import type { BetterAuthPlugin, BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";
import {
  linkDiscourseIdentity,
  resolveDiscourseIdentity,
} from "../src/identity.js";
import type { DiscourseConnectClaims } from "../src/protocol.js";
import type { DiscourseIdentityPolicy } from "../src/identity.js";
import {
  createBetterAuthIdentityGuard,
  identityGuardSchema,
} from "../src/storage/identity.js";

const claims = (
  overrides: Partial<DiscourseConnectClaims> = {},
): DiscourseConnectClaims => ({
  nonce: "n",
  external_id: "00042",
  email: "person@example.test",
  username: "person",
  name: "Discourse Person",
  ...overrides,
});

function identityPlugin(
  policy: Partial<Omit<DiscourseIdentityPolicy, "identityLockStorage">> = {},
): BetterAuthPlugin {
  return {
    id: "identity-test",
    schema: identityGuardSchema,
    endpoints: {
      resolveIdentity: createAuthEndpoint(
        "/identity/resolve",
        { method: "POST" },
        async (ctx) => {
          const result = await resolveDiscourseIdentity(ctx, claims(), {
            disableSignUp: policy.disableSignUp ?? false,
            overrideUserInfoOnSignIn: policy.overrideUserInfoOnSignIn ?? false,
            identityLockStorage: createBetterAuthIdentityGuard(
              ctx.context.adapter,
            ),
            ...(policy.mapProfileToUser
              ? { mapProfileToUser: policy.mapProfileToUser }
              : {}),
          });
          return ctx.json(result);
        },
      ),
      resolveChanged: createAuthEndpoint(
        "/identity/resolve-changed",
        { method: "POST" },
        async (ctx) => {
          return ctx.json(
            await resolveDiscourseIdentity(
              ctx,
              claims({
                email: "changed@example.test",
                username: "renamed",
                name: "Changed Name",
              }),
              {
                disableSignUp: policy.disableSignUp ?? false,
                overrideUserInfoOnSignIn:
                  policy.overrideUserInfoOnSignIn ?? false,
                identityLockStorage: createBetterAuthIdentityGuard(
                  ctx.context.adapter,
                ),
                ...(policy.mapProfileToUser
                  ? { mapProfileToUser: policy.mapProfileToUser }
                  : {}),
              },
            ),
          );
        },
      ),
      linkIdentity: createAuthEndpoint(
        "/identity/link",
        { method: "POST" },
        async (ctx) => {
          const owner = await ctx.context.internalAdapter.createUser(
            {
              email: "local@example.test",
              emailVerified: true,
              name: "Local Name",
            },
            {
              method: "oauth",
              oauth: { providerId: "github", profile: {} },
            },
          );
          const result = await linkDiscourseIdentity(
            ctx,
            claims({ email: "different@example.test" }),
            { userId: owner.id, email: owner.email },
            {
              disableSignUp: false,
              overrideUserInfoOnSignIn: false,
              identityLockStorage: createBetterAuthIdentityGuard(
                ctx.context.adapter,
              ),
            },
          );
          const user = await ctx.context.internalAdapter.findUserById(owner.id);
          return ctx.json({
            result,
            email: user?.email,
            emailVerified: user?.emailVerified,
            name: user?.name,
          });
        },
      ),
      repeatLink: createAuthEndpoint(
        "/identity/repeat-link",
        { method: "POST" },
        async (ctx) => {
          const adapter = ctx.context.internalAdapter;
          const existing = await adapter.findAccountOwnerByKey({
            providerId: "discourse",
            accountId: "repeat-subject",
          });
          const owner =
            existing?.kind === "owned"
              ? existing.user
              : await adapter.createUser(
                  {
                    email: "repeat@example.test",
                    emailVerified: false,
                    name: "Repeat Owner",
                  },
                  {
                    method: "oauth",
                    oauth: { providerId: "github", profile: {} },
                  },
                );
          const result = await linkDiscourseIdentity(
            ctx,
            claims({
              external_id: "repeat-subject",
              email: "repeat@example.test",
            }),
            {
              userId: owner.id,
              email: owner.email,
            },
            {
              disableSignUp: false,
              overrideUserInfoOnSignIn: false,
              identityLockStorage: createBetterAuthIdentityGuard(
                ctx.context.adapter,
              ),
            },
          );
          return ctx.json({ result, userId: owner.id });
        },
      ),
    },
  };
}

async function setup(
  options: Partial<BetterAuthOptions> = {},
  mapping: Parameters<typeof identityPlugin>[0] = {},
) {
  const instance = await getTestInstance({
    plugins: [identityPlugin(mapping)],
    ...options,
  });
  const response = (path: string) =>
    instance.auth.handler(
      new Request(`http://localhost:3000/api/auth${path}`, { method: "POST" }),
    );
  return { ...instance, response };
}

describe("Discourse identity policies (Better Auth SQLite)", () => {
  it("creates with stable string identity and treats provider email as unverified", async () => {
    const { auth, response } = await setup();
    const first = await (await response("/identity/resolve")).json();
    const second = await (await response("/identity/resolve")).json();
    expect(first).toMatchObject({ error: null, isRegister: true });
    expect(second).toMatchObject({ error: null, isRegister: false });
    const adapter = (await auth.$context).internalAdapter;
    expect(
      await adapter.findAccountByKey({
        providerId: "discourse",
        accountId: "00042",
      }),
    ).toMatchObject({ accountId: "00042" });
    expect(
      (await adapter.findUserByEmail("person@example.test"))?.user
        .emailVerified,
    ).toBe(false);
  });

  it("resolves the same identity after email and username change despite a colliding new email", async () => {
    const { auth, response } = await setup();
    const initial = await (await response("/identity/resolve")).json();
    const adapter = (await auth.$context).internalAdapter;
    const collision = await adapter.createUser(
      {
        email: "changed@example.test",
        emailVerified: true,
        name: "Email Owner",
      },
      { method: "oauth", oauth: { providerId: "github", profile: {} } },
    );
    const changed = await (await response("/identity/resolve-changed")).json();
    expect(changed).toMatchObject({
      error: null,
      isRegister: false,
      data: {
        user: { id: initial.data.user.id, email: "person@example.test" },
      },
    });
    expect((await adapter.findUserById(collision.id))?.name).toBe(
      "Email Owner",
    );
  });

  it("preserves an existing profile on sign-in unless override is opted in", async () => {
    const { auth, response } = await setup();
    const adapter = (await auth.$context).internalAdapter;
    const user = await adapter.createUser(
      {
        email: "person@example.test",
        emailVerified: true,
        name: "Locally Owned",
      },
      { method: "oauth", oauth: { providerId: "discourse", profile: {} } },
    );
    await adapter.linkAccount({
      providerId: "discourse",
      accountId: "00042",
      userId: user.id,
    });
    await response("/identity/resolve");
    expect((await adapter.findUserById(user.id))?.name).toBe("Locally Owned");
  });

  it("updates profile only when opted in and applies mapper name/image overrides", async () => {
    const { auth, response } = await setup(
      {},
      {
        overrideUserInfoOnSignIn: true,
        mapProfileToUser: () => ({
          name: "Mapped Name",
          image: "https://example.test/avatar.png",
          id: "spoof",
          accountId: "spoof",
        }),
      },
    );
    const adapter = (await auth.$context).internalAdapter;
    const user = await adapter.createUser(
      { email: "person@example.test", emailVerified: true, name: "Before" },
      { method: "oauth", oauth: { providerId: "discourse", profile: {} } },
    );
    await adapter.linkAccount({
      providerId: "discourse",
      accountId: "00042",
      userId: user.id,
    });
    await response("/identity/resolve");
    expect(await adapter.findUserById(user.id)).toMatchObject({
      name: "Mapped Name",
      image: "https://example.test/avatar.png",
      email: "person@example.test",
      emailVerified: true,
    });
    expect(
      await adapter.findAccountOwnerByKey({
        providerId: "discourse",
        accountId: "00042",
      }),
    ).toMatchObject({ kind: "owned", user: { id: user.id } });
  });

  it("does not create unknown users when sign-up is disabled", async () => {
    const { response } = await setup({}, { disableSignUp: true });
    expect(await (await response("/identity/resolve")).json()).toMatchObject({
      error: expect.any(String),
    });
  });

  it("allows an existing linked identity to sign in when sign-up is disabled", async () => {
    const { auth, response } = await setup({}, { disableSignUp: true });
    const adapter = (await auth.$context).internalAdapter;
    const owner = await adapter.createUser(
      { email: "person@example.test", emailVerified: false, name: "Existing" },
      { method: "oauth", oauth: { providerId: "discourse", profile: {} } },
    );
    await adapter.linkAccount({
      providerId: "discourse",
      accountId: "00042",
      userId: owner.id,
    });
    expect(await (await response("/identity/resolve")).json()).toMatchObject({
      error: null,
      data: { user: { id: owner.id } },
    });
  });

  it("preserves local email and verification during explicit different-email linking", async () => {
    const { response } = await setup({
      account: {
        accountLinking: {
          enabled: true,
          allowDifferentEmails: true,
          trustedProviders: ["discourse"],
        },
      },
    });
    expect(await (await response("/identity/link")).json()).toMatchObject({
      result: { linked: true },
      email: "local@example.test",
      emailVerified: true,
      name: "Local Name",
    });
  });

  it("makes repeated explicit linking by the same local user idempotent", async () => {
    const { auth, response } = await setup({
      account: {
        accountLinking: { enabled: true, trustedProviders: ["discourse"] },
      },
    });
    const first = await (await response("/identity/repeat-link")).json();
    const second = await (await response("/identity/repeat-link")).json();
    expect(first.result).toMatchObject({ linked: true });
    expect(second.result).toMatchObject({ linked: true });
    expect(second.userId).toBe(first.userId);
    expect(
      await (
        await auth.$context
      ).internalAdapter.findAccountOwnerByKey({
        providerId: "discourse",
        accountId: "repeat-subject",
      }),
    ).toMatchObject({ kind: "owned", user: { id: first.userId } });
  });

  it("rejects explicit linking when host linking is disabled or provider is untrusted", async () => {
    const disabled = await setup({
      account: {
        accountLinking: {
          enabled: false,
          allowDifferentEmails: true,
          trustedProviders: ["discourse"],
        },
      },
    });
    expect(
      await (await disabled.response("/identity/link")).json(),
    ).toMatchObject({ result: { linked: false } });
    const untrusted = await setup({
      account: {
        accountLinking: {
          enabled: true,
          allowDifferentEmails: true,
          trustedProviders: [],
        },
      },
    });
    expect(
      await (await untrusted.response("/identity/link")).json(),
    ).toMatchObject({ result: { linked: false } });
  });

  it("requires the different-email host switch for explicit linking", async () => {
    const { response } = await setup({
      account: {
        accountLinking: { enabled: true, trustedProviders: ["discourse"] },
      },
    });
    expect(await (await response("/identity/link")).json()).toMatchObject({
      result: { linked: false },
      email: "local@example.test",
      emailVerified: true,
    });
  });

  it("honors requireLocalEmailVerified while provider email remains unverified", async () => {
    const createCollision = async (config: Partial<BetterAuthOptions>) => {
      const { auth, response } = await setup(config);
      await (
        await auth.$context
      ).internalAdapter.createUser(
        { email: "person@example.test", emailVerified: false, name: "Local" },
        { method: "oauth", oauth: { providerId: "github", profile: {} } },
      );
      return (await response("/identity/resolve")).json();
    };
    expect(
      await createCollision({
        account: {
          accountLinking: { enabled: true, trustedProviders: ["discourse"] },
        },
      }),
    ).toMatchObject({ error: "account not linked" });
    expect(
      await createCollision({
        account: {
          accountLinking: {
            enabled: true,
            requireLocalEmailVerified: false,
            trustedProviders: ["discourse"],
          },
        },
      }),
    ).toMatchObject({ error: null, isRegister: false });
  });

  it("fails closed when two different local users concurrently claim one provider identity", async () => {
    // Use two connections to the same on-disk lock table, not a process mutex.
    const endpointFor = (path: string) =>
      createAuthEndpoint(path, { method: "POST" }, async (ctx) => {
        const owner = await ctx.context.internalAdapter.createUser(
          {
            email: `${Math.random()}@example.test`,
            emailVerified: false,
            name: "Owner",
          },
          { method: "oauth", oauth: { providerId: "github", profile: {} } },
        );
        return ctx.json(
          await linkDiscourseIdentity(
            ctx,
            claims({ external_id: "race-id", email: "elsewhere@example.test" }),
            { userId: owner.id, email: owner.email },
            {
              disableSignUp: false,
              overrideUserInfoOnSignIn: false,
              identityLockStorage: createBetterAuthIdentityGuard(
                ctx.context.adapter,
              ),
            },
          ),
        );
      });
    // Use the public request context exposed by a temporary plugin endpoint by making calls concurrently.
    // The deployed helper is separately characterized below; this endpoint is mounted on a fresh test auth.
    const withRacer = await getTestInstance({
      plugins: [
        {
          id: "racer",
          endpoints: {
            raceA: endpointFor("/identity/competing-link-a"),
            raceB: endpointFor("/identity/competing-link-b"),
          },
        },
        identityPlugin(),
      ],
      account: {
        accountLinking: {
          enabled: true,
          allowDifferentEmails: true,
          trustedProviders: ["discourse"],
        },
      },
    });
    const race = (path: string) =>
      withRacer.auth.handler(
        new Request(`http://localhost:3000/api/auth${path}`, {
          method: "POST",
        }),
      );
    const responses = await Promise.all([
      race("/identity/competing-link-a"),
      race("/identity/competing-link-b"),
    ]);
    expect(responses.every((r) => r.status === 200 || r.status === 500)).toBe(
      true,
    );
    const results = await Promise.all(
      responses.filter((r) => r.status === 200).map((r) => r.json()),
    );
    // Both writers may have persisted before either post-check. If so the
    // public owner lookup itself must fail as ambiguous and neither response
    // may report linked/authenticated success.
    expect(results.filter((r) => r.linked === true)).toHaveLength(1);
    const adapter = (await withRacer.auth.$context).internalAdapter;
    expect(
      await adapter.findAccountOwnerByKey({
        providerId: "discourse",
        accountId: "race-id",
      }),
    ).toMatchObject({ kind: "owned" });
  });

  it("characterizes concurrent first sign-in claims and returns no ambiguous session", async () => {
    const { auth, response } = await setup();
    const responses = await Promise.all([
      response("/identity/resolve"),
      response("/identity/resolve"),
    ]);
    const bodies = await Promise.all(
      responses.map(async (r) => {
        if (r.status !== 200) return null;
        try {
          return await r.json();
        } catch {
          return null;
        }
      }),
    );
    const adapter = (await auth.$context).internalAdapter;
    let owner;
    try {
      owner = await adapter.findAccountOwnerByKey({
        providerId: "discourse",
        accountId: "00042",
      });
    } catch (error) {
      expect(String(error)).toMatch(/Multiple accounts match/);
    }
    if (!owner || owner.kind !== "owned") {
      expect(bodies.every((body) => !body || body.error !== null)).toBe(true);
    } else {
      expect(
        bodies
          .filter((body) => body?.error === null)
          .every((body) => body.data.user.id === owner.user.id),
      ).toBe(true);
    }
  });

  it("applies mapped additional fields and rejects invalid additional values", async () => {
    const validator = {
      input: {
        "~standard": {
          version: 1 as const,
          vendor: "identity-test",
          validate: (value: unknown) =>
            value === "member"
              ? { value }
              : { issues: [{ message: "invalid" }] },
        },
      },
    };
    const transformValidator = {
      input: {
        "~standard": {
          version: 1 as const,
          vendor: "identity-test",
          validate: (value: unknown) =>
            typeof value === "string"
              ? { value: value.trim().toLowerCase() }
              : { issues: [{ message: "invalid" }] },
        },
      },
    };
    const options = {
      user: {
        additionalFields: {
          forumRole: {
            type: "string",
            required: false,
            input: true,
            validator,
          },
          normalizedRole: {
            type: "string",
            required: false,
            input: true,
            validator: transformValidator,
          },
        },
      },
    } satisfies BetterAuthOptions;
    const good = await setup(options, {
      mapProfileToUser: () => ({
        forumRole: "member",
        normalizedRole: " MEMBER ",
        emailVerified: true,
        id: "spoof",
      }),
    });
    expect(
      await (await good.response("/identity/resolve")).json(),
    ).toMatchObject({ error: null });
    expect(
      (
        await good.auth.$context.then((ctx) =>
          ctx.internalAdapter.findUserByEmail("person@example.test"),
        )
      )?.user,
    ).toMatchObject({ forumRole: "member", normalizedRole: "member" });
    const bad = await setup(options, {
      mapProfileToUser: () => ({ forumRole: "admin" }),
    });
    const invalid = await bad.response("/identity/resolve");
    expect(invalid.status).toBe(500);
  });

  it("validates supported additional-field arrays, enums, JSON, dates, and defaults", async () => {
    const schema = {
      user: {
        additionalFields: {
          tags: { type: "string[]", required: false },
          scores: { type: "number[]", required: false },
          access: { type: ["basic", "admin"], required: false },
          preferences: { type: "json", required: false },
          joinedAt: { type: "date", required: false },
          roleDefault: {
            type: "string",
            required: false,
            defaultValue: "member",
          },
          tenantCode: { type: "string", required: false },
        },
      },
    } as unknown as BetterAuthOptions;
    const good = await setup(schema, {
      mapProfileToUser: () => ({
        tags: ["one", "two"],
        scores: [1, 2.5],
        access: "admin",
        preferences: { theme: "dark" },
        joinedAt: new Date("2025-01-01T00:00:00.000Z"),
        tenantCode: "t-1",
      }),
    });
    expect(
      await (await good.response("/identity/resolve")).json(),
    ).toMatchObject({ error: null });
    await expect(
      (await good.auth.$context).internalAdapter.findUserByEmail(
        "person@example.test",
      ),
    ).resolves.toMatchObject({
      user: {
        tags: ["one", "two"],
        scores: [1, 2.5],
        access: "admin",
        preferences: { theme: "dark" },
        roleDefault: "member",
        tenantCode: "t-1",
      },
    });

    const invalid = await setup(schema, {
      mapProfileToUser: () => ({
        tags: ["valid", 2],
        scores: [1],
        access: "root",
        preferences: {},
        joinedAt: new Date(),
        tenantCode: "t-2",
      }),
    });
    expect((await invalid.response("/identity/resolve")).status).toBe(500);
  });

  it("applies Better Auth create hooks", async () => {
    const hookSetup = await getTestInstance({
      plugins: [identityPlugin()],
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
    const response = () =>
      hookSetup.auth.handler(
        new Request("http://localhost:3000/api/auth/identity/resolve", {
          method: "POST",
        }),
      );
    const created = await (await response()).json();
    expect(created).toMatchObject({
      error: null,
      data: { user: { name: "Discourse Person (hook)" } },
    });
  });

  it("lets Better Auth's provider-profile parser reject a missing required additional field", () => {
    const options = {
      user: {
        additionalFields: { tenantCode: { type: "string", required: true } },
      },
    } as unknown as BetterAuthOptions;
    expect(() =>
      parseAdditionalUserInputFromProviderProfile(options, {}, "create"),
    ).toThrow("tenantCode is required");
  });

  it("runs Better Auth update hooks for opted-in profile updates", async () => {
    const { auth, response } = await setup(
      {
        databaseHooks: {
          user: {
            update: {
              before: async (user) => ({
                data: { ...user, name: `${user.name} (updated)` },
              }),
            },
          },
        },
      },
      { overrideUserInfoOnSignIn: true },
    );
    const adapter = (await auth.$context).internalAdapter;
    const user = await adapter.createUser(
      { email: "person@example.test", emailVerified: false, name: "Before" },
      { method: "oauth", oauth: { providerId: "discourse", profile: {} } },
    );
    await adapter.linkAccount({
      providerId: "discourse",
      accountId: "00042",
      userId: user.id,
    });
    await response("/identity/resolve");
    expect(await adapter.findUserById(user.id)).toMatchObject({
      name: "Discourse Person (updated)",
      email: "person@example.test",
      emailVerified: false,
    });
  });
});
