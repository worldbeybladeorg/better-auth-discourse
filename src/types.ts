import type { DiscourseProfile, DiscourseUserMapping } from "./identity.js";

export interface DiscourseOptions {
  /** Site root, e.g. https://community.example.com (no path/query/fragment). */
  discourseURL: string;
  /** DiscourseConnect HMAC secret. */
  secret: string;
  /** Disable new local user registration. Defaults to false. */
  disableSignUp?: boolean;
  /** Update existing profiles at sign-in. Defaults to false. */
  overrideUserInfoOnSignIn?: boolean;
  mapProfileToUser?: (profile: DiscourseProfile) => DiscourseUserMapping;
}
