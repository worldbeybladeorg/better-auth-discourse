import type { BetterAuthOptions } from "better-auth";
import { getTestInstance } from "better-auth/test";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discourse } from "../src/index.js";

const secret = "transaction-workflow-discourse-secret";
type Operation = "sign-in" | "link";

async function setup(
  operation: Operation,
  options: BetterAuthOptions = {},
  pluginOptions: Partial<Parameters<typeof discourse>[0]> = {},
) {
  const origin =
    typeof options.baseURL === "string"
      ? new URL(options.baseURL).origin
      : "http://localhost:3000";
  const basePath = (options.basePath ?? "/api/auth").replace(/\/$/, "");
  const endpoint = (path: string) => `${origin}${basePath}${path}`;
  const { auth, testUser } = await getTestInstance({
    secret: "stable-transaction-workflow-integrity-secret",
    trustedOrigins: [origin, "https://trusted.example.test"],
    account: {
      accountLinking: {
        enabled: true,
        allowDifferentEmails: true,
        trustedProviders: ["discourse"],
      },
    },
    ...options,
    plugins: [
      discourse({
        discourseURL: "https://forum.example.test",
        secret,
        ...pluginOptions,
      }),
    ],
  });
  let localCookie = "";
  if (operation === "link") {
    const response = await auth.handler(
      new Request(endpoint("/sign-in/email"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: testUser.email,
          password: testUser.password,
        }),
      }),
    );
    expect(response.status).toBe(200);
    localCookie = response.headers
      .getSetCookie()
      .find((cookie) => cookie.includes("session_token="))!
      .split(";")[0]!;
  }
  return {
    auth,
    endpoint,
    start: (body: Record<string, string> = {}) =>
      auth.handler(
        new Request(
          endpoint(
            operation === "sign-in" ? "/sign-in/discourse" : "/discourse/link",
          ),
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              cookie: localCookie,
            },
            body: JSON.stringify(body),
          },
        ),
      ),
    finish: (
      launch: { nonce: string; cookie: string },
      externalId = "workflow-member",
      binding = launch.cookie,
      validSignature = true,
    ) => {
      const payload = Buffer.from(
        new URLSearchParams({
          nonce: launch.nonce,
          external_id: externalId,
          email: "provider@example.test",
        }).toString(),
      ).toString("base64");
      const signature = createHmac("sha256", secret)
        .update(payload)
        .digest("hex");
      const query = new URLSearchParams({
        sso: payload,
        sig: validSignature
          ? signature
          : `${signature[0] === "0" ? "1" : "0"}${signature.slice(1)}`,
      });
      return auth.handler(
        new Request(`${endpoint("/discourse/callback")}?${query}`, {
          headers: {
            cookie: [localCookie, binding].filter(Boolean).join("; "),
          },
        }),
      );
    },
  };
}

async function readLaunch(response: Response) {
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.redirect).toBe(true);
  const provider = new URL(result.url);
  const encoded = provider.searchParams.get("sso")!;
  const claims = new URLSearchParams(Buffer.from(encoded, "base64").toString());
  const nonce = claims.get("nonce")!;
  const binding = response.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`discourse-connect-${nonce}=`))!;
  expect(binding).toBeDefined();
  return { provider, claims, nonce, binding, cookie: binding.split(";")[0]! };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe.each(["sign-in", "link"] as const)(
  "DiscourseConnect transaction workflow: %s",
  (operation) => {
    it.each([
      {
        name: "both defaults",
        body: {},
        success: "/",
        failure: "/?error=AUTHENTICATION_FAILED",
      },
      {
        name: "error destination defaults to success",
        body: { callbackURL: "/done?keep=1#saved" },
        success: "/done?keep=1#saved",
        failure: "/done?keep=1&error=AUTHENTICATION_FAILED#saved",
      },
      {
        name: "explicit error destination",
        body: { errorCallbackURL: "/retry?keep=1&error=old#saved" },
        success: "/",
        failure: "/retry?keep=1&error=AUTHENTICATION_FAILED#saved",
      },
      {
        name: "trusted absolute destinations",
        body: {
          callbackURL: "https://trusted.example.test/done",
          errorCallbackURL: "https://trusted.example.test/retry?keep=1#saved",
        },
        success: "https://trusted.example.test/done",
        failure:
          "https://trusted.example.test/retry?keep=1&error=AUTHENTICATION_FAILED#saved",
      },
    ])(
      "retains $name through success and failure",
      async ({ body, success, failure }) => {
        const workflow = await setup(
          operation,
          {},
          {
            mapProfileToUser: (profile) => {
              if (profile.id === "mapping-failure")
                throw new Error("mapping rejected");
              return {};
            },
          },
        );
        const launch = await readLaunch(await workflow.start(body));
        const completed = await workflow.finish(launch);
        expect(completed.status).toBe(302);
        expect(completed.headers.get("location")).toBe(success);

        const failing = await readLaunch(await workflow.start(body));
        const failed = await workflow.finish(failing, "mapping-failure");
        expect(failed.status).toBe(302);
        expect(failed.headers.get("location")).toBe(failure);
        expect(failed.headers.get("set-cookie") ?? "").not.toContain(
          "session_token",
        );
        expect(failed.headers.getSetCookie()).toContainEqual(
          expect.stringContaining(`discourse-connect-${failing.nonce}=;`),
        );
        const replay = await workflow.finish(failing, "mapping-failure");
        expect(replay.status).toBe(400);
        expect(await replay.json()).toMatchObject({ code: "INVALID_STATE" });
      },
    );

    it.each([
      {
        environment: "development",
        baseURL: "http://localhost:3000",
        basePath: "/api/auth",
        secure: false,
      },
      {
        environment: "development",
        baseURL: "https://consumer.example.test",
        basePath: "/custom/auth",
        secure: true,
      },
      {
        environment: "production",
        baseURL: "http://localhost:3000",
        basePath: "/custom/auth",
        secure: true,
      },
      {
        environment: "development",
        baseURL: "http://localhost:3000",
        basePath: "/",
        secure: false,
      },
    ])(
      "matches binding cookie issuance and removal for $environment $baseURL$basePath",
      async ({ environment, baseURL, basePath, secure }) => {
        vi.stubEnv("NODE_ENV", environment);
        vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
        const workflow = await setup(operation, { baseURL, basePath });
        const launch = await readLaunch(await workflow.start());
        expect(launch.nonce).toMatch(/^[a-f0-9]{64}$/);
        expect(launch.cookie).toMatch(
          /^discourse-connect-[a-f0-9]{64}=[a-f0-9]{64}$/,
        );
        expect(launch.cookie.split("=")[1]).not.toBe(launch.nonce);
        expect(launch.claims.get("return_sso_url")).toBe(
          workflow.endpoint("/discourse/callback"),
        );
        expect(launch.provider.searchParams.get("sig")).toBe(
          createHmac("sha256", secret)
            .update(launch.provider.searchParams.get("sso")!)
            .digest("hex"),
        );
        const issuedAttributes = launch.binding
          .split(";")
          .map((part) => part.trim());
        expect(issuedAttributes).toEqual(
          expect.arrayContaining([
            `Path=${basePath}`,
            "Max-Age=300",
            "HttpOnly",
            "SameSite=Lax",
          ]),
        );
        expect(issuedAttributes.includes("Secure")).toBe(secure);
        expect(launch.binding).not.toContain("Domain=");
        expect(launch.binding).not.toContain("Expires=");

        const completed = await workflow.finish(launch);
        expect(completed.status).toBe(302);
        const cleared = completed.headers
          .getSetCookie()
          .find((cookie) =>
            cookie.startsWith(`discourse-connect-${launch.nonce}=`),
          )!;
        const clearedAttributes = cleared.split(";").map((part) => part.trim());
        expect(clearedAttributes).toEqual(
          expect.arrayContaining([
            `Path=${basePath}`,
            "Max-Age=0",
            "HttpOnly",
            "SameSite=Lax",
          ]),
        );
        expect(clearedAttributes.includes("Secure")).toBe(secure);
        expect(cleared).toMatch(/^discourse-connect-[a-f0-9]{64}=;/);
        if (operation === "link") {
          expect(completed.headers.get("set-cookie") ?? "").not.toContain(
            "session_token",
          );
        }
      },
    );

    it.each(["callbackURL", "errorCallbackURL"])(
      "rejects an untrusted %s without issuing a binding cookie",
      async (field) => {
        const workflow = await setup(operation);
        const response = await workflow.start({
          [field]: "https://attacker.example/",
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "INVALID_REQUEST",
        });
        expect(response.headers.get("set-cookie") ?? "").not.toContain(
          "discourse-connect-",
        );
      },
    );

    it("rejects a nonempty browser mismatch without consuming the bound transaction", async () => {
      const workflow = await setup(operation);
      const launch = await readLaunch(await workflow.start());
      const mismatch = await workflow.finish(
        launch,
        "workflow-member",
        `discourse-connect-${launch.nonce}=wrong-browser`,
      );
      expect(mismatch.status).toBe(400);
      expect(await mismatch.json()).toMatchObject({ code: "INVALID_STATE" });
      expect(mismatch.headers.get("set-cookie") ?? "").not.toContain(
        "session_token",
      );
      expect((await workflow.finish(launch)).status).toBe(302);
    });

    it("rejects an invalid signature without consuming or clearing the bound transaction", async () => {
      const workflow = await setup(operation);
      const launch = await readLaunch(await workflow.start());
      const invalid = await workflow.finish(
        launch,
        "workflow-member",
        launch.cookie,
        false,
      );
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "INVALID_RESPONSE" });
      expect(invalid.headers.get("set-cookie") ?? "").not.toContain(
        "discourse-connect-",
      );
      expect((await workflow.finish(launch)).status).toBe(302);
    });
  },
);

it("requires a local session before validating explicit-link destinations", async () => {
  const workflow = await setup("sign-in");
  const response = await workflow.auth.handler(
    new Request(workflow.endpoint("/discourse/link"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackURL: "https://attacker.example/" }),
    }),
  );
  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
});

it("consumes a linking transaction before rejecting an expired initiating local session", async () => {
  const now = new Date("2026-11-08T12:00:00Z");
  vi.setSystemTime(now);
  const workflow = await setup("link", {
    session: { expiresIn: 60, updateAge: 60 },
  });
  const launch = await readLaunch(
    await workflow.start({
      errorCallbackURL: "/accounts?keep=1#link",
    }),
  );
  vi.setSystemTime(now.getTime() + 61_000);
  const expired = await workflow.finish(launch);
  expect(expired.status).toBe(302);
  expect(expired.headers.get("location")).toBe(
    "/accounts?keep=1&error=SESSION_INVALID#link",
  );
  // Better Auth may clear the expired cookie, but must not issue a new token.
  expect(expired.headers.get("set-cookie") ?? "").not.toMatch(
    /session_token=[^;]/,
  );
  const replay = await workflow.finish(launch);
  expect(replay.status).toBe(400);
  expect(await replay.json()).toMatchObject({ code: "INVALID_STATE" });
});
