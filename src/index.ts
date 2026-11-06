import type { BetterAuthPlugin } from "better-auth";
import type { DiscourseOptions } from "./types.js";
import { createSignInDiscourse } from "./endpoints/sign-in.js";
import { createDiscourseCallback } from "./endpoints/callback.js";
import { createLinkDiscourse } from "./endpoints/link.js";
import { transactionStateSchema } from "./state.js";
import { identityGuardSchema } from "./storage/identity.js";

export type { DiscourseOptions } from "./types.js";
export type { DiscourseProfile, DiscourseUserMapping } from "./identity.js";
export { DISCOURSE_ERROR_CODES } from "./errors.js";
export type { DiscourseErrorCode } from "./errors.js";

function validateOptions(options: DiscourseOptions): void {
  if (typeof options.secret !== "string" || options.secret.length === 0)
    throw new Error("DISCOURSE_SECRET_REQUIRED");
  if (
    typeof options.discourseURL !== "string" ||
    options.discourseURL.trim() !== options.discourseURL ||
    // eslint-disable-next-line no-control-regex -- Reject control characters before URL parsing can normalize them.
    /[\u0000-\u0020\u007f\\]/.test(options.discourseURL) ||
    options.discourseURL.includes("?") ||
    options.discourseURL.includes("#")
  )
    throw new Error("INVALID_DISCOURSE_URL");
  let url: URL;
  try {
    url = new URL(options.discourseURL);
  } catch {
    throw new Error("INVALID_DISCOURSE_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("INVALID_DISCOURSE_URL");
}

/** DiscourseConnect server plugin. Sign-in endpoint returns { url, redirect: true }. */
export function discourse(options: DiscourseOptions) {
  validateOptions(options);
  return {
    id: "discourse",
    init(ctx) {
      if (!ctx.options.database) throw new Error("DISCOURSE_DATABASE_REQUIRED");
    },
    schema: { ...transactionStateSchema, ...identityGuardSchema },
    endpoints: {
      signInDiscourse: createSignInDiscourse(options),
      discourseCallback: createDiscourseCallback({
        secret: options.secret,
        disableSignUp: options.disableSignUp ?? false,
        overrideUserInfoOnSignIn: options.overrideUserInfoOnSignIn ?? false,
        ...(options.mapProfileToUser
          ? { mapProfileToUser: options.mapProfileToUser }
          : {}),
      }),
      linkDiscourse: createLinkDiscourse(options),
    },
  } as const satisfies BetterAuthPlugin;
}
