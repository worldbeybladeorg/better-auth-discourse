/** Node.js 24+ server configuration with the built-in persistent SQLite API. */
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { discourse } from "better-auth-discourse";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
};

// This is a file-backed database, not an in-memory adapter. Create its parent
// directory before starting the application and run migrations separately.
const database = new DatabaseSync(
  process.env.SQLITE_PATH ?? "./data/auth.sqlite",
);

export const auth = betterAuth({
  database,
  // BETTER_AUTH_URL is the complete auth base URL, including /api/auth.
  baseURL: required("BETTER_AUTH_URL"),
  secret: required("BETTER_AUTH_SECRET"),
  plugins: [
    discourse({
      discourseURL: required("DISCOURSE_URL"),
      secret: required("DISCOURSE_CONNECT_SECRET"),
      // New local accounts are allowed by default. Set true to require an
      // existing local account; client input cannot override this policy.
      disableSignUp: false,
      // The default is false: do not overwrite existing user profile fields.
      overrideUserInfoOnSignIn: false,
      // Only standard local profile fields are mapped in this example. Restrict
      // this mapping to data the application actually wants to persist.
      mapProfileToUser: (profile) => ({
        name: profile.name,
        image: profile.image,
      }),
    }),
  ],
  // Linking is an explicit application policy, not enabled by the plugin.
  // Uncomment only if your app intentionally trusts Discourse for account
  // linking; this does NOT verify the provider email or bypass other BA checks.
  // account: { accountLinking: { enabled: true, trustedProviders: ["discourse"] } },
});

// Mount this handler at BETTER_AUTH_URL's path (usually /api/auth).
export const handleAuthRequest = (request: Request) => auth.handler(request);
