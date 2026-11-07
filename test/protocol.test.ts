import { describe, expect, it } from "vitest";
import {
  createDiscourseConnectRequest,
  DiscourseConnectProtocolError,
  verifyDiscourseConnectResponse,
} from "../src/protocol.js";

// HMAC values independently generated with Python's hmac/hashlib (not the
// implementation under test). Source format/claim fields: pinned Discourse
// discourse_connect_base.rb and discourse_connect_provider.rb, commit
// 5c954dc77fef0d7600e3a92be40acca3fab8d9e0.
const secret = "fixture-secret";
const fixturePayload =
  "bm9uY2U9bi0xMjMmZXh0ZXJuYWxfaWQ9MDAwMDQyJmVtYWlsPWolQzMlQjZAZXhhbXBsZS50ZXN0Jm5hbWU9Wm8lQzMlQUIrJTI2KyVFOSU5QiVBQQ==";
const fixtureSignature =
  "ce0c5d6e23e8b311c419a567a512666edb0549fcd490ba32eafc4ebcd393ca56";

function signed(payload: string): Promise<string> {
  return crypto.subtle
    .importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    .then(async (key) => {
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(payload),
        ),
      );
      return [...signature]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
    });
}

async function responseFor(unsigned: string): Promise<string> {
  const payload = btoa(
    String.fromCharCode(...new TextEncoder().encode(unsigned)),
  );
  return `sso=${encodeURIComponent(payload)}&sig=${await signed(payload)}`;
}

describe("DiscourseConnect protocol", () => {
  it("creates the provider request using URL-encoded UTF-8 and signs exact Base64 text", async () => {
    const request = await createDiscourseConnectRequest({
      discourseURL: "https://community.example.test/base",
      returnSSOURL: "https://app.example.test/callback?x=a b&y=雪",
      nonce: "n +雪",
      secret,
    });
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(request.payload), (char) => char.charCodeAt(0)),
    );
    expect(decoded).toBe(
      "nonce=n+%2B%E9%9B%AA&return_sso_url=https%3A%2F%2Fapp.example.test%2Fcallback%3Fx%3Da+b%26y%3D%E9%9B%AA",
    );
    expect(request.signature).toBe(await signed(request.payload));
    expect(new URL(request.authorizationURL).pathname).toBe(
      "/session/sso_provider",
    );
  });

  it("verifies the reference HMAC and preserves the external ID as text", async () => {
    const claims = await verifyDiscourseConnectResponse(
      `sso=${encodeURIComponent(fixturePayload)}&sig=${fixtureSignature}`,
      secret,
    );
    expect(claims).toEqual({
      nonce: "n-123",
      external_id: "000042",
      email: "jö@example.test",
      name: "Zoë & 雪",
    });
  });

  it("rejects a changed payload before interpreting claims", async () => {
    await expect(
      verifyDiscourseConnectResponse(
        `sso=${encodeURIComponent(fixturePayload)}&sig=${"0".repeat(64)}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
  });

  it("rejects duplicate outer and signed claim parameters", async () => {
    await expect(
      verifyDiscourseConnectResponse(
        `sso=${fixturePayload}&sso=${fixturePayload}&sig=${fixtureSignature}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_PARAMETER" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor("nonce=x&external_id=1&external_id=2&email=a@b.test"),
        secret,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_PARAMETER" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor("nonce=x&external_id=1&email=a@b.test&%6eonce=y"),
        secret,
      ),
    ).rejects.toMatchObject({ code: "DUPLICATE_PARAMETER" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor("nonce=x&external_id=1&email=a%40b.test&%Q0=x"),
        secret,
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
  });

  it("enforces byte, key, value, and parameter-count limits", async () => {
    const required = "nonce=x&external_id=1&email=a@b.test";
    await expect(
      verifyDiscourseConnectResponse(
        `${"x".repeat(24_577)}&sig=${"0".repeat(64)}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor(`${required}&large=${"a".repeat(4_097)}`),
        secret,
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor(`${required}&${"k".repeat(129)}=x`),
        secret,
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor(
          `${required}&${Array.from({ length: 62 }, (_, i) => `x${i}=1`).join("&")}`,
        ),
        secret,
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor(
          `${required}&a=${"x".repeat(3_500)}&b=${"x".repeat(3_500)}&c=${"x".repeat(3_500)}&d=${"x".repeat(3_500)}`,
        ),
        secret,
      ),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("rejects empty required claims and malformed failed values", async () => {
    for (const claim of ["nonce", "external_id", "email"]) {
      const values = {
        nonce: "n",
        external_id: "1",
        email: "a@b.test",
        [claim]: "",
      };
      const unsigned = `nonce=${encodeURIComponent(values.nonce)}&external_id=${encodeURIComponent(values.external_id)}&email=${encodeURIComponent(values.email)}`;
      await expect(
        verifyDiscourseConnectResponse(await responseFor(unsigned), secret),
      ).rejects.toMatchObject({ code: "MISSING_CLAIM" });
    }
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor("nonce=n&external_id=1&email=a%40b.test&failed=yes"),
        secret,
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
  });

  it("exposes provider role, group, background, and 2FA claims", async () => {
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor(
          "nonce=n&external_id=1&email=a%40b.test&groups=Staff%2CTrust%20Level%202&admin=true&moderator=false&profile_background_url=%2Fprofile&card_background_url=%2Fcard&confirmed_2fa=false&no_2fa_methods=true",
        ),
        secret,
      ),
    ).resolves.toMatchObject({
      groups: "Staff,Trust Level 2",
      admin: true,
      moderator: false,
      profile_background_url: "/profile",
      card_background_url: "/card",
      confirmed_2fa: false,
      no_2fa_methods: true,
    });
    const absent = await verifyDiscourseConnectResponse(
      await responseFor("nonce=n&external_id=1&email=a%40b.test&groups="),
      secret,
    );
    expect(absent).toHaveProperty("groups", "");
    expect(absent).not.toHaveProperty("admin");
    for (const claim of [
      "admin",
      "moderator",
      "confirmed_2fa",
      "no_2fa_methods",
    ]) {
      await expect(
        verifyDiscourseConnectResponse(
          await responseFor(
            `nonce=n&external_id=1&email=a%40b.test&${claim}=yes`,
          ),
          secret,
        ),
      ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
      await expect(
        verifyDiscourseConnectResponse(
          await responseFor(
            `nonce=n&external_id=1&email=a%40b.test&${claim}=true&${claim}=false`,
          ),
          secret,
        ),
      ).rejects.toMatchObject({ code: "DUPLICATE_PARAMETER" });
    }
  });

  it("accepts unknown signed claims but rejects unknown outer parameters", async () => {
    const claims = await verifyDiscourseConnectResponse(
      await responseFor(
        "nonce=n&external_id=1&email=a%40b.test&future_claim=value",
      ),
      secret,
    );
    expect(claims).not.toHaveProperty("future_claim");
    await expect(
      verifyDiscourseConnectResponse(
        `sso=${fixturePayload}&sig=${fixtureSignature}&extra=x`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
  });

  it("accepts either signature hex case, but rejects malformed signatures", async () => {
    const upperSignature = fixtureSignature.toUpperCase();
    await expect(
      verifyDiscourseConnectResponse(
        `sso=${fixturePayload}&sig=${upperSignature}`,
        secret,
      ),
    ).resolves.toHaveProperty("external_id", "000042");
    for (const signature of ["abc", "g".repeat(64)]) {
      await expect(
        verifyDiscourseConnectResponse(
          `sso=${fixturePayload}&sig=${signature}`,
          secret,
        ),
      ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    }
  });

  it("rejects non-canonical Base64 after a valid signature", async () => {
    // YR== decodes to the same byte as YQ== in permissive decoders, but is not canonical Base64.
    await expect(
      verifyDiscourseConnectResponse(
        `sso=YR%3D%3D&sig=${await signed("YR==")}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "INVALID_BASE64" });
  });

  it("does not infer email verification from require_activation", async () => {
    for (const value of ["true", "false"]) {
      const claims = await verifyDiscourseConnectResponse(
        await responseFor(
          `nonce=n&external_id=1&email=a%40b.test&require_activation=${value}`,
        ),
        secret,
      );
      expect(claims).not.toHaveProperty("emailVerified");
      expect(claims).not.toHaveProperty("require_activation");
    }
  });

  it("checks the signature before decoding malformed Base64 content", async () => {
    const validSignature = await signed("%%%");
    await expect(
      verifyDiscourseConnectResponse(
        "sso=%25%25%25&sig=" + "0".repeat(64),
        secret,
      ),
    ).rejects.toMatchObject({ code: "INVALID_SIGNATURE" });
    await expect(
      verifyDiscourseConnectResponse(
        `sso=%25%25%25&sig=${validSignature}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "INVALID_BASE64" });
  });

  it("rejects unsafe or oversized request configuration", async () => {
    const base = {
      discourseURL: "https://community.example.test",
      returnSSOURL: "https://app.example.test/callback",
      nonce: "nonce",
      secret,
    };
    for (const discourseURL of [
      "javascript:alert(1)",
      "https://user:pass@community.example.test",
    ]) {
      await expect(
        createDiscourseConnectRequest({ ...base, discourseURL }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    await expect(
      createDiscourseConnectRequest({
        ...base,
        returnSSOURL: "file:///etc/passwd",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createDiscourseConnectRequest({ ...base, nonce: "n".repeat(513) }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    await expect(
      createDiscourseConnectRequest({
        ...base,
        returnSSOURL: `https://app.example.test/${"x".repeat(4_096)}`,
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
  });

  it("rejects malformed base64, query escapes, and invalid UTF-8", async () => {
    await expect(
      verifyDiscourseConnectResponse(
        `sso=%25%25%25&sig=${await signed("%%%")}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "INVALID_BASE64" });
    const malformedQuery = "nonce=%Q0&external_id=1&email=a%40b.test";
    await expect(
      verifyDiscourseConnectResponse(await responseFor(malformedQuery), secret),
    ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
    const invalidUtf8 = btoa(String.fromCharCode(0xff));
    await expect(
      verifyDiscourseConnectResponse(
        `sso=${invalidUtf8}&sig=${await signed(invalidUtf8)}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "MALFORMED_QUERY" });
  });

  it("rejects failed authentication and responses missing required claims", async () => {
    const failedPayload =
      "bm9uY2U9bi0xMjMmZXh0ZXJuYWxfaWQ9NDImZW1haWw9b2slNDBleGFtcGxlLnRlc3QmZmFpbGVkPXRydWU=";
    const failedSignature =
      "ccd832f1f4be27a3b3f04716b2c972f1f57f1eed978a6e6898ee15a5d26c4623";
    await expect(
      verifyDiscourseConnectResponse(
        `sso=${failedPayload}&sig=${failedSignature}`,
        secret,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor("nonce=n-123&failed=true"),
        secret,
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await expect(
      verifyDiscourseConnectResponse(
        await responseFor("nonce=x&email=a@b.test"),
        secret,
      ),
    ).rejects.toMatchObject({ code: "MISSING_CLAIM" });
  });

  it("exposes safe, payload-free protocol errors", async () => {
    try {
      await verifyDiscourseConnectResponse("sso=a&sig=b", secret);
    } catch (error) {
      expect(error).toBeInstanceOf(DiscourseConnectProtocolError);
      expect((error as Error).message).not.toContain("sso=a");
    }
  });
});
