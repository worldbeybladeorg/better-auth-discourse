import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { discourse } from "better-auth-discourse";

function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and configure it first.`,
    );
  return value;
}

const secret = required("BETTER_AUTH_SECRET");
if (secret.length < 32)
  throw new Error("BETTER_AUTH_SECRET must be at least 32 characters.");

const baseURL = required("BETTER_AUTH_URL");
if (new URL(baseURL).pathname !== "/api/auth") {
  throw new Error(
    "This example requires BETTER_AUTH_URL to end with /api/auth.",
  );
}

const sqlitePath = resolve(process.env.SQLITE_PATH ?? "./data/auth.sqlite");
mkdirSync(dirname(sqlitePath), { recursive: true });
export const database = new DatabaseSync(sqlitePath);
database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

export const linkingEnabled =
  process.env.DISCOURSE_TRUST_FOR_LINKING === "true";

export const auth = betterAuth({
  database,
  baseURL,
  secret,
  // Local credentials let you create a separate local user before testing linking.
  // Demo only: no verification email or password-reset delivery is configured.
  emailAndPassword: { enabled: true },
  account: {
    accountLinking: {
      enabled: linkingEnabled,
      trustedProviders: linkingEnabled ? ["discourse"] : [],
    },
  },
  plugins: [
    discourse({
      discourseURL: required("DISCOURSE_URL"),
      secret: required("DISCOURSE_CONNECT_SECRET"),
      disableSignUp: false,
      overrideUserInfoOnSignIn: false,
      mapProfileToUser: (profile) => ({
        name: profile.name,
        image: profile.image,
      }),
    }),
  ],
});
