/** Browser-only module: no server plugin, database, process.env, or secrets. */
import { createAuthClient } from "better-auth/client";
import { discourseClient } from "better-auth-discourse/client";

export const authClient = createAuthClient({
  // Browser-facing auth URL, including the configured Better Auth base path.
  baseURL: "http://localhost:3000/api/auth",
  plugins: [discourseClient()],
});

export const beginDiscourseSignIn = () =>
  authClient.signIn.discourse({
    callbackURL: "/dashboard",
  });

export const beginDiscourseLink = () =>
  authClient.discourse.link({
    callbackURL: "/settings/accounts",
  });
