import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { createBetterAuthIdentityGuard } from "../storage/identity.js";
import {
  linkDiscourseIdentity,
  resolveDiscourseIdentity,
} from "../identity.js";
import type { DiscourseProfile, DiscourseUserMapping } from "../identity.js";
import { recoverDiscourseTransaction } from "./transaction.js";

export const createDiscourseCallback = (options: {
  secret: string;
  disableSignUp: boolean;
  overrideUserInfoOnSignIn: boolean;
  mapProfileToUser?: (profile: DiscourseProfile) => DiscourseUserMapping;
}) =>
  createAuthEndpoint("/discourse/callback", { method: "GET" }, async (ctx) => {
    const transaction = await recoverDiscourseTransaction(ctx, options.secret);
    // Preserve construction after state recovery and outside the redirect catch.
    const identityLockStorage = createBetterAuthIdentityGuard(
      ctx.context.adapter,
    );
    return transaction.complete(async (verified) => {
      if (verified.operation === "link") {
        const result = await linkDiscourseIdentity(
          ctx,
          verified.claims,
          verified.initiatingUser,
          {
            disableSignUp: options.disableSignUp,
            overrideUserInfoOnSignIn: options.overrideUserInfoOnSignIn,
            identityLockStorage,
            ...(options.mapProfileToUser
              ? { mapProfileToUser: options.mapProfileToUser }
              : {}),
          },
        );
        if (!result.linked) return "LINK_FAILED";
      } else {
        const result = await resolveDiscourseIdentity(ctx, verified.claims, {
          disableSignUp: options.disableSignUp,
          overrideUserInfoOnSignIn: options.overrideUserInfoOnSignIn,
          identityLockStorage,
          ...(options.mapProfileToUser
            ? { mapProfileToUser: options.mapProfileToUser }
            : {}),
        });
        if (result.error || !("data" in result) || !result.data)
          return "SIGN_IN_FAILED";
        await setSessionCookie(ctx, result.data);
      }
    });
  });
