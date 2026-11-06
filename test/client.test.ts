import { createAuthClient } from "better-auth/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discourseClient } from "../src/client.js";

describe("DiscourseConnect client plugin", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends inferred sign-in and link requests through Better Auth fetch", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createAuthClient({
      baseURL: "https://app.example.test/api/auth",
      plugins: [discourseClient()],
      fetchOptions: {
        customFetchImpl: async (input, init) => {
          calls.push({
            url: String(input),
            method: init?.method ?? "GET",
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
          });
          return new Response(
            JSON.stringify({
              url: "https://community.example.test/session/sso",
              redirect: true,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    });

    await client.signIn.discourse({ callbackURL: "/dashboard" });
    await client.discourse.link({ callbackURL: "/settings/accounts" });

    expect(calls).toEqual([
      {
        url: "https://app.example.test/api/auth/sign-in/discourse",
        method: "POST",
        body: { callbackURL: "/dashboard" },
      },
      {
        url: "https://app.example.test/api/auth/discourse/link",
        method: "POST",
        body: { callbackURL: "/settings/accounts" },
      },
    ]);
  });

  it("preserves Better Auth's non-throwing error response behavior", async () => {
    let navigation = "";
    vi.stubGlobal("window", {
      location: {
        set href(url: string) {
          navigation = url;
        },
      },
    });
    const client = createAuthClient({
      baseURL: "https://app.example.test/api/auth",
      plugins: [discourseClient()],
      fetchOptions: {
        customFetchImpl: async () =>
          new Response(
            JSON.stringify({
              code: "SESSION_REQUIRED",
              message: "Sign in first",
            }),
            {
              status: 401,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    });

    const result = await client.discourse.link({
      callbackURL: "/settings/accounts",
    });
    expect(result.error?.status).toBe(401);
    expect(result.error?.message).toBe("Sign in first");
    expect(navigation).toBe("");
  });

  it("uses Better Auth's default redirect fetch plugin in browsers", async () => {
    let navigation = "";
    vi.stubGlobal("window", {
      location: {
        set href(url: string) {
          navigation = url;
        },
      },
    });
    const client = createAuthClient({
      baseURL: "https://app.example.test/api/auth",
      plugins: [discourseClient()],
      fetchOptions: {
        customFetchImpl: async () =>
          new Response(
            JSON.stringify({
              url: "https://community.example.test/session/sso",
              redirect: true,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      },
    });

    await client.signIn.discourse({ callbackURL: "/dashboard" });
    expect(navigation).toBe("https://community.example.test/session/sso");
  });
});
