import { createAuthEndpoint } from "better-auth/api";
import { getSessionCookie, setSessionCookie } from "better-auth/cookies";
import { verifyDiscourseConnectResponse } from "../protocol.js";
import { consumeTransactionState } from "../state.js";
import { createBetterAuthTransactionStateStorage } from "../storage/better-auth.js";
import { createBetterAuthIdentityGuard } from "../storage/identity.js";
import {
  linkDiscourseIdentity,
  resolveDiscourseIdentity,
} from "../identity.js";
import type { DiscourseProfile, DiscourseUserMapping } from "../identity.js";
import type { DiscourseConnectClaims } from "../protocol.js";
import { activeSession, browserSecret, clearBinding } from "./common.js";
import { discourseAPIError } from "../errors.js";

export const createDiscourseCallback = (options: {
  secret: string;
  disableSignUp: boolean;
  overrideUserInfoOnSignIn: boolean;
  mapProfileToUser?: (profile: DiscourseProfile) => DiscourseUserMapping;
}) =>
  createAuthEndpoint("/discourse/callback", { method: "GET" }, async (ctx) => {
    let claims: DiscourseConnectClaims;
    try {
      const url = new URL(ctx.request!.url);
      // The protocol module verifies the exact raw query, including duplicate-parameter rejection.
      claims = await verifyDiscourseConnectResponse(
        url.search.slice(1),
        options.secret,
      );
    } catch {
      throw discourseAPIError("INVALID_RESPONSE");
    }
    if (!/^[a-f0-9]{64}$/.test(claims.nonce))
      throw discourseAPIError("INVALID_STATE");
    let stored;
    try {
      const secret = browserSecret(ctx, claims.nonce);
      if (!secret) throw discourseAPIError("INVALID_STATE");
      stored = await consumeTransactionState(
        createBetterAuthTransactionStateStorage(ctx.context.adapter),
        { nonce: claims.nonce, browserSecret: secret },
        ctx.context.secret,
      );
      clearBinding(ctx, claims.nonce);
    } catch {
      throw discourseAPIError("INVALID_STATE");
    }
    if (!stored) throw discourseAPIError("INVALID_STATE");
    const identityLockStorage = createBetterAuthIdentityGuard(
      ctx.context.adapter,
    );
    try {
      if (stored.operation === "link") {
        const live = await activeSession(ctx);
        if (
          !live?.user ||
          live.user.id !== stored.initiatingUserId ||
          live.session?.id !== stored.initiatingSessionId ||
          !live.session ||
          new Date(live.session.expiresAt).getTime() <= Date.now()
        ) {
          return ctx.redirect(appendError(stored.errorURL, "SESSION_INVALID"));
        }
        // Token hash is rechecked using the live cookie token, without persisting the token in state.
        const token = getSessionCookie(ctx.headers!);
        const tokenBytes = new TextEncoder().encode(token ?? "");
        const hashBytes = new Uint8Array(
          await crypto.subtle.digest("SHA-256", tokenBytes),
        );
        const digest = Array.from(hashBytes, (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("");
        if (digest !== stored.initiatingSessionTokenHash)
          return ctx.redirect(appendError(stored.errorURL, "SESSION_INVALID"));
        const result = await linkDiscourseIdentity(
          ctx,
          claims,
          { userId: live.user.id, email: live.user.email },
          {
            disableSignUp: options.disableSignUp,
            overrideUserInfoOnSignIn: options.overrideUserInfoOnSignIn,
            identityLockStorage,
            ...(options.mapProfileToUser
              ? { mapProfileToUser: options.mapProfileToUser }
              : {}),
          },
        );
        if (!result.linked)
          return ctx.redirect(appendError(stored.errorURL, "LINK_FAILED"));
      } else {
        const result = await resolveDiscourseIdentity(ctx, claims, {
          disableSignUp: options.disableSignUp,
          overrideUserInfoOnSignIn: options.overrideUserInfoOnSignIn,
          identityLockStorage,
          ...(options.mapProfileToUser
            ? { mapProfileToUser: options.mapProfileToUser }
            : {}),
        });
        if (result.error || !("data" in result) || !result.data)
          return ctx.redirect(appendError(stored.errorURL, "SIGN_IN_FAILED"));
        await setSessionCookie(ctx, result.data);
      }
      return ctx.redirect(stored.successURL);
    } catch {
      return ctx.redirect(
        appendError(stored.errorURL, "AUTHENTICATION_FAILED"),
      );
    }
  });

function appendError(destination: string, code: string): string {
  const url = new URL(destination, "http://localhost");
  url.searchParams.set("error", code);
  return destination.startsWith("/")
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}
