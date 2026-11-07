import type { DiscourseProfile } from "better-auth-discourse";

export type DiscourseProfileSnapshot = DiscourseProfile & {
  capturedAt: string;
};

/** Only display text: provider URLs and strings must never become HTML. */
export function formatDiscourseProfile(
  snapshot: DiscourseProfileSnapshot | null | undefined,
): string {
  if (!snapshot)
    return "No Discourse profile captured. Sign in or link with Discourse.";
  return JSON.stringify(
    {
      ...snapshot,
      groups: snapshot.groups ?? "Not provided",
      admin: snapshot.admin ?? "Not provided",
      moderator: snapshot.moderator ?? "Not provided",
      profileBackgroundURL: snapshot.profileBackgroundURL ?? "Not provided",
      cardBackgroundURL: snapshot.cardBackgroundURL ?? "Not provided",
      confirmed2FA: snapshot.confirmed2FA ?? "Not provided",
      no2FAMethods: snapshot.no2FAMethods ?? "Not provided",
    },
    null,
    2,
  );
}
