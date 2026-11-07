import { createAuthClient } from "better-auth/client";
import { discourseClient } from "../src/client.js";
import type { DiscourseProfile } from "../src/index.js";

const authClient = createAuthClient({ plugins: [discourseClient()] });

void authClient.signIn.discourse({ callbackURL: "/dashboard" });
void authClient.discourse.link({ callbackURL: "/settings/accounts" });

const profile: DiscourseProfile = {
  id: "subject",
  email: "person@example.test",
  name: "Person",
  groups: ["Staff"],
  admin: false,
  moderator: true,
  profileBackgroundURL: "/profile",
  cardBackgroundURL: "/card",
  confirmed2FA: false,
  no2FAMethods: true,
};
void profile;

// @ts-expect-error callbackURL must be a string
void authClient.signIn.discourse({ callbackURL: 42 });
// @ts-expect-error client cannot control server-enforced registration policy
void authClient.signIn.discourse({ disableSignUp: false });
// @ts-expect-error linking accepts only the documented endpoint fields
void authClient.discourse.link({ arbitrary: "value" });
