import { getTestInstance } from "better-auth/test";
import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { discourse } from "../src/index.js";

const plugin = (overrides: Partial<Parameters<typeof discourse>[0]> = {}) =>
  discourse({
    discourseURL: "https://forum.example.test",
    secret: "test-discourse-secret",
    ...overrides,
  });
function callbackQuery(
  nonce: string,
  externalId = "member-42",
  email = "member@example.test",
  extraClaims = "",
) {
  const payload = Buffer.from(
    `nonce=${encodeURIComponent(nonce)}&external_id=${externalId}&email=${encodeURIComponent(email)}${extraClaims ? `&${extraClaims}` : ""}`,
  ).toString("base64");
  const signature = createHmac("sha256", "test-discourse-secret")
    .update(payload)
    .digest("hex");
  return `sso=${encodeURIComponent(payload)}&sig=${signature}`;
}

async function setup(
  pluginOptions: Partial<Parameters<typeof discourse>[0]> = {},
  options: Record<string, unknown> = {},
) {
  const instance = await getTestInstance({
    plugins: [plugin(pluginOptions)],
    secret: "stable-test-integrity-secret",
    ...options,
  });
  return instance;
}

async function begin(
  auth: { handler(request: Request): Promise<Response> },
  callbackURL = "/welcome",
) {
  const response = await auth.handler(
    new Request("http://localhost:3000/api/auth/sign-in/discourse", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackURL }),
    }),
  );
  const launch = await response.json();
  const sso = new URL(launch.url).searchParams.get("sso")!;
  const nonce = new URLSearchParams(Buffer.from(sso, "base64").toString()).get(
    "nonce",
  )!;
  return { nonce, cookie: response.headers.get("set-cookie")!.split(";")[0]! };
}

describe("Discourse endpoint composition", () => {
  it("passes signed provider profile claims to the mapper on sign-in and explicit linking", async () => {
    const observed: import("../src/identity.js").DiscourseProfile[] = [];
    const { auth } = await setup({
      mapProfileToUser: (profile) => {
        observed.push(profile);
        return {};
      },
    });
    const { nonce, cookie } = await begin(auth);
    const signedClaims =
      "groups=&admin=false&moderator=true&profile_background_url=%2Fprofile.png&card_background_url=%2Fcard.png&confirmed_2fa=false&no_2fa_methods=true";
    const signedIn = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce, "member-42", "member@example.test", signedClaims)}`,
        { headers: { cookie } },
      ),
    );
    expect(signedIn.status).toBe(302);
    expect(observed[0]).toMatchObject({
      groups: [],
      admin: false,
      moderator: true,
      profileBackgroundURL: "/profile.png",
      cardBackgroundURL: "/card.png",
      confirmed2FA: false,
      no2FAMethods: true,
    });
    expect(observed[0]).not.toHaveProperty("username");

    const { auth: linkingAuth } = await setup(
      {
        mapProfileToUser: (profile) => {
          observed.push(profile);
          return {};
        },
      },
      {
        account: {
          accountLinking: {
            enabled: true,
            allowDifferentEmails: true,
            trustedProviders: ["discourse"],
          },
        },
      },
    );
    const signup = await linkingAuth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local User",
          email: "local@example.test",
          password: "password-123456",
        }),
      }),
    );
    const localCookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const start = await linkingAuth.handler(
      new Request("http://localhost:3000/api/auth/discourse/link", {
        method: "POST",
        headers: { cookie: localCookie, "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/settings/accounts" }),
      }),
    );
    const encoded = new URL((await start.json()).url).searchParams.get("sso")!;
    const linkNonce = new URLSearchParams(
      Buffer.from(encoded, "base64").toString(),
    ).get("nonce")!;
    const binding = start.headers.get("set-cookie")!.split(";")[0]!;
    const linked = await linkingAuth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(linkNonce, "linked-42", "provider@example.test", "groups=Staff%2CTrust%20Level%202&admin=true&moderator=false&profile_background_url=%2Fprovider-profile&card_background_url=%2Fprovider-card&confirmed_2fa=true&no_2fa_methods=false")}`,
        { headers: { cookie: `${localCookie}; ${binding}` } },
      ),
    );
    expect(linked.status).toBe(302);
    expect(linked.headers.get("location")).toBe("/settings/accounts");
    expect(observed[1]).toMatchObject({
      groups: ["Staff", "Trust Level 2"],
      admin: true,
      moderator: false,
      profileBackgroundURL: "/provider-profile",
      cardBackgroundURL: "/provider-card",
      confirmed2FA: true,
      no2FAMethods: false,
    });
    const localUser = await (
      await linkingAuth.$context
    ).internalAdapter.findUserByEmail("local@example.test");
    expect(localUser?.user).not.toHaveProperty("admin");
    expect(localUser?.user).not.toHaveProperty("confirmed2FA");
  });

  it("registers both persistent schemas and returns the documented redirect result", async () => {
    const { auth } = await setup();
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/discourse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/welcome" }),
      }),
    );
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({
      redirect: true,
      url: expect.stringContaining(
        "https://forum.example.test/session/sso_provider",
      ),
    });
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("HttpOnly");
    expect(cookies).toContain("SameSite=Lax");
    expect(cookies).toContain("discourse-connect-");
  });

  it("completes a signed first sign-in and issues a Better Auth session only on success", async () => {
    const { auth } = await setup();
    const begin = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/discourse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/welcome" }),
      }),
    );
    const launch = await begin.json();
    const provider = new URL(launch.url);
    const sso = provider.searchParams.get("sso")!;
    const nonce = new URLSearchParams(
      Buffer.from(sso, "base64").toString(),
    ).get("nonce")!;
    const setCookie = begin.headers.get("set-cookie")!;
    const binding = setCookie.split(";")[0]!;
    const callback = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce)}`,
        {
          headers: { cookie: binding },
        },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/welcome");
    expect(callback.headers.get("set-cookie")).toContain(
      "better-auth.session_token",
    );
    const cookies = callback.headers.get("set-cookie")!;
    const sessionCookie = cookies
      .split(",")
      .find((cookie) => cookie.includes("session_token"))!
      .split(";")[0]!;
    const session = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie: sessionCookie },
      }),
    );
    expect(await session.json()).toMatchObject({
      user: { email: "member@example.test", emailVerified: false },
    });
  });

  it("rejects signature tampering before creating a local identity", async () => {
    const { auth } = await setup();
    const { nonce, cookie } = await begin(auth);
    const signedQuery = callbackQuery(nonce);
    const signature = signedQuery.match(/sig=([a-f0-9]+)/)![1]!;
    const changed = `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`;
    expect(changed).not.toBe(signature);
    const invalid = signedQuery.replace(`sig=${signature}`, `sig=${changed}`);
    const response = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${invalid}`,
        { headers: { cookie } },
      ),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_RESPONSE" });
    expect(
      await (
        await auth.$context
      ).internalAdapter.findUserByEmail("member@example.test"),
    ).toBeNull();
  });

  it("rejects expired signed transactions without creating a user or issuing a session", async () => {
    const { auth } = await setup();
    const { nonce, cookie } = await begin(auth);
    vi.setSystemTime(Date.now() + 6 * 60_000);
    try {
      const response = await auth.handler(
        new Request(
          `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce)}`,
          { headers: { cookie } },
        ),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "INVALID_STATE" });
      expect(response.headers.get("set-cookie") ?? "").not.toContain(
        "session_token",
      );
      expect(
        await (
          await auth.$context
        ).internalAdapter.findUserByEmail("member@example.test"),
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows exactly one callback to consume a sign-in transaction", async () => {
    const { auth } = await setup();
    const { nonce, cookie } = await begin(auth);
    const url = `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce)}`;
    const request = () =>
      auth.handler(new Request(url, { headers: { cookie } }));
    const results = await Promise.all([request(), request()]);
    expect(results.map((response) => response.status).sort()).toEqual([
      302, 400,
    ]);
    const user = await (
      await auth.$context
    ).internalAdapter.findUserByEmail("member@example.test");
    expect(user).not.toBeNull();
  });

  it("resolves a returning identity by stable external ID after the provider email changes", async () => {
    const { auth } = await setup();
    const finish = async (email: string) => {
      const { nonce, cookie } = await begin(auth);
      return auth.handler(
        new Request(
          `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce, "member-42", email)}`,
          { headers: { cookie } },
        ),
      );
    };
    const first = await finish("member@example.test");
    expect(first.status).toBe(302);
    const identity = await (
      await auth.$context
    ).internalAdapter.findAccountByKey({
      providerId: "discourse",
      accountId: "member-42",
    });
    const returning = await finish("renamed@example.test");
    expect(returning.status).toBe(302);
    const identityAfter = await (
      await auth.$context
    ).internalAdapter.findAccountByKey({
      providerId: "discourse",
      accountId: "member-42",
    });
    expect(identityAfter?.userId).toBe(identity?.userId);
  });

  it("enforces disabled signup while allowing identity configuration to initialize", async () => {
    const { auth } = await setup({ disableSignUp: true });
    const { nonce, cookie } = await begin(auth);
    const callback = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce)}`,
        { headers: { cookie } },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=SIGN_IN_FAILED");
    expect(
      await (
        await auth.$context
      ).internalAdapter.findUserByEmail("member@example.test"),
    ).toBeNull();
    expect(callback.headers.get("set-cookie")).not.toContain("session_token");
  });

  it("requires a live session to begin explicit linking and preserves it on successful callback", async () => {
    const { auth } = await setup(
      {},
      {
        account: {
          accountLinking: {
            enabled: true,
            allowDifferentEmails: true,
            trustedProviders: ["discourse"],
          },
        },
      },
    );
    const signup = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local User",
          email: "local@example.test",
          password: "password-123456",
        }),
      }),
    );
    expect(signup.status).toBe(200);
    const localCookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const start = await auth.handler(
      new Request("http://localhost:3000/api/auth/discourse/link", {
        method: "POST",
        headers: { cookie: localCookie, "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/settings/accounts" }),
      }),
    );
    expect(start.status).toBe(200);
    const launch = await start.json();
    const encoded = new URL(launch.url).searchParams.get("sso")!;
    const nonce = new URLSearchParams(
      Buffer.from(encoded, "base64").toString(),
    ).get("nonce")!;
    const binding = start.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce, "linked-42", "provider@example.test")}`,
        {
          headers: { cookie: `${localCookie}; ${binding}` },
        },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/settings/accounts");
    expect(callback.headers.get("set-cookie")).not.toContain("session_token");
    expect(
      await (
        await auth.$context
      ).internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: "linked-42",
      }),
    ).not.toBeNull();
  });

  it("rejects explicit-link initiation without an authenticated session", async () => {
    const { auth } = await setup();
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/discourse/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
  });

  it("does not turn an ordinary sign-in started in an authenticated browser into linking", async () => {
    const { auth } = await setup(
      {},
      {
        account: {
          accountLinking: {
            enabled: true,
            allowDifferentEmails: true,
            trustedProviders: ["discourse"],
          },
        },
      },
    );
    const signup = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local User",
          email: "member@example.test",
          password: "password-123456",
        }),
      }),
    );
    const localCookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const started = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/discourse", {
        method: "POST",
        headers: { cookie: localCookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const sso = new URL((await started.json()).url).searchParams.get("sso")!;
    const nonce = new URLSearchParams(
      Buffer.from(sso, "base64").toString(),
    ).get("nonce")!;
    const binding = started.headers.get("set-cookie")!.split(";")[0]!;
    const result = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce)}`,
        { headers: { cookie: `${localCookie}; ${binding}` } },
      ),
    );
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("error=SIGN_IN_FAILED");
    expect(
      await (
        await auth.$context
      ).internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: "member-42",
      }),
    ).toBeNull();
  });

  it("rejects explicit linking after the initiating session is revoked", async () => {
    const { auth } = await setup(
      {},
      {
        account: {
          accountLinking: {
            enabled: true,
            allowDifferentEmails: true,
            trustedProviders: ["discourse"],
          },
        },
      },
    );
    const signup = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local User",
          email: "local@example.test",
          password: "password-123456",
        }),
      }),
    );
    const localCookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const started = await auth.handler(
      new Request("http://localhost:3000/api/auth/discourse/link", {
        method: "POST",
        headers: { cookie: localCookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const sso = new URL((await started.json()).url).searchParams.get("sso")!;
    const nonce = new URLSearchParams(
      Buffer.from(sso, "base64").toString(),
    ).get("nonce")!;
    const binding = started.headers.get("set-cookie")!.split(";")[0]!;
    await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: { cookie: localCookie },
      }),
    );
    const result = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce, "linked-42", "local@example.test")}`,
        { headers: { cookie: `${localCookie}; ${binding}` } },
      ),
    );
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("error=SESSION_INVALID");
    expect(
      await (
        await auth.$context
      ).internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: "linked-42",
      }),
    ).toBeNull();
  });

  it("keeps an already-owned Discourse identity bound to its original user on link conflict", async () => {
    const { auth } = await setup(
      {},
      {
        account: {
          accountLinking: {
            enabled: true,
            allowDifferentEmails: true,
            trustedProviders: ["discourse"],
          },
        },
      },
    );
    const { nonce: signinNonce, cookie: signinCookie } = await begin(auth);
    const signin = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(signinNonce, "shared-identity", "owner@example.test")}`,
        { headers: { cookie: signinCookie } },
      ),
    );
    expect(signin.status).toBe(302);
    const owner = await (
      await auth.$context
    ).internalAdapter.findAccountByKey({
      providerId: "discourse",
      accountId: "shared-identity",
    });
    const signup = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Other User",
          email: "other@example.test",
          password: "password-123456",
        }),
      }),
    );
    const localCookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const start = await auth.handler(
      new Request("http://localhost:3000/api/auth/discourse/link", {
        method: "POST",
        headers: { cookie: localCookie, "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "/settings" }),
      }),
    );
    const sso = new URL((await start.json()).url).searchParams.get("sso")!;
    const linkNonce = new URLSearchParams(
      Buffer.from(sso, "base64").toString(),
    ).get("nonce")!;
    const binding = start.headers.get("set-cookie")!.split(";")[0]!;
    const result = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(linkNonce, "shared-identity", "owner@example.test")}`,
        { headers: { cookie: `${localCookie}; ${binding}` } },
      ),
    );
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toContain("error=LINK_FAILED");
    const after = await (
      await auth.$context
    ).internalAdapter.findAccountByKey({
      providerId: "discourse",
      accountId: "shared-identity",
    });
    expect(after?.userId).toBe(owner?.userId);
    expect(result.headers.get("set-cookie")).not.toContain("session_token");
  });

  it("rejects linking after the same user signs in with a replacement session", async () => {
    const { auth } = await setup(
      {},
      {
        account: {
          accountLinking: {
            enabled: true,
            allowDifferentEmails: true,
            trustedProviders: ["discourse"],
          },
        },
      },
    );
    const signup = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "Local User",
          email: "local@example.test",
          password: "password-123456",
        }),
      }),
    );
    const oldCookie = signup.headers.get("set-cookie")!.split(";")[0]!;
    const start = await auth.handler(
      new Request("http://localhost:3000/api/auth/discourse/link", {
        method: "POST",
        headers: { cookie: oldCookie, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    const sso = new URL((await start.json()).url).searchParams.get("sso")!;
    const nonce = new URLSearchParams(
      Buffer.from(sso, "base64").toString(),
    ).get("nonce")!;
    const binding = start.headers.get("set-cookie")!.split(";")[0]!;
    await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-out", {
        method: "POST",
        headers: { cookie: oldCookie },
      }),
    );
    const replacement = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "local@example.test",
          password: "password-123456",
        }),
      }),
    );
    const newCookie = replacement.headers.get("set-cookie")!.split(";")[0]!;
    const callback = await auth.handler(
      new Request(
        `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce, "replacement-test", "local@example.test")}`,
        { headers: { cookie: `${newCookie}; ${binding}` } },
      ),
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("error=SESSION_INVALID");
    expect(
      await (
        await auth.$context
      ).internalAdapter.findAccountByKey({
        providerId: "discourse",
        accountId: "replacement-test",
      }),
    ).toBeNull();
  });

  it("rejects a callback from a browser without the transaction cookie and permits retry from the bound browser", async () => {
    const { auth } = await setup();
    const { nonce, cookie } = await begin(auth);
    const url = `http://localhost:3000/api/auth/discourse/callback?${callbackQuery(nonce)}`;
    const mismatch = await auth.handler(new Request(url));
    expect(mismatch.status).toBe(400);
    const retry = await auth.handler(new Request(url, { headers: { cookie } }));
    expect(retry.status).toBe(302);
  });

  it("rejects an untrusted destination over HTTP", async () => {
    const { auth } = await setup();
    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/discourse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callbackURL: "https://attacker.example/" }),
      }),
    );
    const result = await response.json();
    expect(response.status).toBe(400);
    expect(result).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects an untrusted destination through direct auth.api calls", async () => {
    const { auth } = await setup();
    await expect(
      auth.api.signInDiscourse({
        body: { callbackURL: "https://attacker.example/" },
      }),
    ).rejects.toMatchObject({ body: { code: "INVALID_REQUEST" } });
  });

  it("rejects ambiguous or unsafe Discourse site configuration", () => {
    expect(() =>
      discourse({
        discourseURL: "https://user:pass@forum.example.test",
        secret: "x",
      }),
    ).toThrow("INVALID_DISCOURSE_URL");
    expect(() =>
      discourse({
        discourseURL: "https://forum.example.test/path",
        secret: "x",
      }),
    ).toThrow("INVALID_DISCOURSE_URL");
    expect(() =>
      discourse({ discourseURL: "https://forum.example.test", secret: "" }),
    ).toThrow("DISCOURSE_SECRET_REQUIRED");
  });

  it("requires Better Auth's persistent database during plugin initialization", async () => {
    const plugin = discourse({
      discourseURL: "https://forum.example.test/",
      secret: "x",
    });
    await expect(
      Promise.resolve().then(() => plugin.init!({ options: {} } as never)),
    ).rejects.toThrow("DISCOURSE_DATABASE_REQUIRED");
  });
});
