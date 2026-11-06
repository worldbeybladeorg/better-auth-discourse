import { handleOAuthUserInfo, linkOAuthAccount } from "better-auth/oauth2";
import type { DiscourseConnectClaims } from "./protocol.js";
import type { DiscourseIdentityLockStorage } from "./storage/identity.js";

/** The deliberately small profile surface offered to application mapping. */
export interface DiscourseProfile {
  id: string;
  email: string;
  name: string;
  image?: string;
  username?: string;
  bio?: string;
  location?: string;
  title?: string;
  website?: string;
}

export type DiscourseUserMapping = Record<string, unknown>;

export interface DiscourseIdentityPolicy {
  disableSignUp: boolean;
  overrideUserInfoOnSignIn: boolean;
  identityLockStorage: DiscourseIdentityLockStorage;
  mapProfileToUser?: (profile: DiscourseProfile) => DiscourseUserMapping;
}

export interface DiscourseLinkInitiator {
  userId: string;
  email: string;
}

export type DiscourseIdentityResult = Awaited<
  ReturnType<typeof handleOAuthUserInfo>
>;
export type DiscourseLinkResult = Awaited<ReturnType<typeof linkOAuthAccount>>;

export class DiscourseIdentityError extends Error {
  constructor(
    readonly code:
      | "INVALID_PROFILE"
      | "INVALID_ADDITIONAL_FIELD"
      | "IDENTITY_BINDING_CONFLICT",
  ) {
    super(code);
    this.name = "DiscourseIdentityError";
  }
}

const RESERVED = new Set([
  "id",
  "createdAt",
  "updatedAt",
  "email",
  "emailVerified",
  "providerId",
  "accountId",
  "userId",
]);
type EndpointContext = Parameters<typeof handleOAuthUserInfo>[0];

function profileFrom(claims: DiscourseConnectClaims): DiscourseProfile {
  const name = claims.name || claims.username || claims.email;
  return {
    id: claims.external_id,
    email: claims.email,
    name,
    ...(claims.username !== undefined ? { username: claims.username } : {}),
    ...(claims.avatar_url !== undefined ? { image: claims.avatar_url } : {}),
    ...(claims.bio !== undefined ? { bio: claims.bio } : {}),
    ...(claims.location !== undefined ? { location: claims.location } : {}),
    ...(claims.title !== undefined ? { title: claims.title } : {}),
    ...(claims.website !== undefined ? { website: claims.website } : {}),
  };
}

async function mappedUser(
  ctx: EndpointContext,
  profile: DiscourseProfile,
  policy: DiscourseIdentityPolicy,
): Promise<Record<string, unknown>> {
  const mapped = policy.mapProfileToUser?.(profile) ?? {};
  if (!mapped || typeof mapped !== "object" || Array.isArray(mapped))
    throw new DiscourseIdentityError("INVALID_PROFILE");
  const result: Record<string, unknown> = {
    name: profile.name,
    image: profile.image,
  };
  if (typeof mapped.name === "string") result.name = mapped.name;
  if (typeof mapped.image === "string" || mapped.image === null)
    result.image = mapped.image;
  for (const [key, value] of Object.entries(mapped)) {
    if (RESERVED.has(key)) continue;
    const field = ctx.context.options.user?.additionalFields?.[key];
    if (!field) continue;
    const validator = field.validator?.input;
    if (validator) {
      const validation = validator["~standard"].validate(value);
      // Better Auth 1.7.18's own parser rejects async validators; mirror its
      // synchronous Standard Schema semantics and preserve transformed values.
      if (
        validation instanceof Promise ||
        ("issues" in validation && validation.issues)
      ) {
        throw new DiscourseIdentityError("INVALID_ADDITIONAL_FIELD");
      }
      // Pass the original input onward; Better Auth's OAuth profile parser
      // applies the validator's transformed value once at persistence time.
    } else if (!matchesFieldType(field.type, value)) {
      throw new DiscourseIdentityError("INVALID_ADDITIONAL_FIELD");
    }
    result[key] = value;
  }
  return result;
}

function matchesFieldType(
  type: string | readonly string[],
  value: unknown,
): boolean {
  if (Array.isArray(type)) return type.includes(value as string);
  if (type === "string") return typeof value === "string";
  if (type === "number")
    return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "date")
    return value instanceof Date && Number.isFinite(value.getTime());
  if (type === "json") return value !== null && typeof value === "object";
  if (type === "string[]")
    return (
      Array.isArray(value) && value.every((item) => typeof item === "string")
    );
  if (type === "number[]")
    return (
      Array.isArray(value) &&
      value.every((item) => typeof item === "number" && Number.isFinite(item))
    );
  return false;
}

/** Resolve/create a local user through Better Auth's public OAuth policy. */
export async function resolveDiscourseIdentity(
  ctx: EndpointContext,
  claims: DiscourseConnectClaims,
  policy: DiscourseIdentityPolicy,
): Promise<DiscourseIdentityResult> {
  if (
    typeof claims.external_id !== "string" ||
    !claims.external_id ||
    typeof claims.email !== "string" ||
    !claims.email
  ) {
    throw new DiscourseIdentityError("INVALID_PROFILE");
  }
  const profile = profileFrom(claims);
  const userInfo = {
    ...(await mappedUser(ctx, profile, policy)),
    id: claims.external_id,
    email: claims.email,
    emailVerified: false,
  } as Parameters<typeof handleOAuthUserInfo>[1]["userInfo"];
  return policy.identityLockStorage.withLocks(
    [
      `account:discourse:${claims.external_id}`,
      `email:${claims.email.toLowerCase()}`,
    ],
    async () => {
      const resolved = await handleOAuthUserInfo(ctx, {
        userInfo,
        account: { providerId: "discourse", accountId: claims.external_id },
        source: {
          method: "oauth",
          oauth: { providerId: "discourse", profile: { ...claims } },
        },
        disableSignUp: policy.disableSignUp,
        overrideUserInfo: policy.overrideUserInfoOnSignIn,
        requireExactAccountBinding: true,
      });
      if (resolved.error || !("data" in resolved) || !resolved.data)
        return resolved;
      // The persistent key guard serializes plugin writers. Verify that Better
      // Auth's returned session belongs to the now-established account owner.
      try {
        const owner = await ctx.context.internalAdapter.findAccountOwnerByKey({
          providerId: "discourse",
          accountId: claims.external_id,
        });
        if (
          owner?.kind !== "owned" ||
          owner.user.id !== resolved.data.user.id
        ) {
          return {
            error: "identity binding conflict",
            data: null,
          } as DiscourseIdentityResult;
        }
      } catch {
        return {
          error: "identity binding conflict",
          data: null,
        } as DiscourseIdentityResult;
      }
      return resolved;
    },
  );
}

/** Explicitly link to the initiating user only; never infer that user by email. */
export async function linkDiscourseIdentity(
  ctx: EndpointContext,
  claims: DiscourseConnectClaims,
  initiatingUser: DiscourseLinkInitiator,
  policy: DiscourseIdentityPolicy,
): Promise<DiscourseLinkResult> {
  if (
    typeof claims.external_id !== "string" ||
    !claims.external_id ||
    typeof claims.email !== "string" ||
    !claims.email
  ) {
    throw new DiscourseIdentityError("INVALID_PROFILE");
  }
  const profile = profileFrom(claims);
  const userInfo = (await mappedUser(ctx, profile, policy)) as Parameters<
    typeof linkOAuthAccount
  >[1]["userInfo"];
  return policy.identityLockStorage.withLocks(
    [
      `account:discourse:${claims.external_id}`,
      `email:${initiatingUser.email.toLowerCase()}`,
      `email:${claims.email.toLowerCase()}`,
    ],
    async () => {
      const linked = await linkOAuthAccount(ctx, {
        link: { userId: initiatingUser.userId, email: initiatingUser.email },
        userInfo: { ...userInfo, email: claims.email, emailVerified: false },
        account: { providerId: "discourse", accountId: claims.external_id },
        profile: { ...claims },
      });
      if (!linked.linked) return linked;
      try {
        const owner = await ctx.context.internalAdapter.findAccountOwnerByKey({
          providerId: "discourse",
          accountId: claims.external_id,
        });
        if (
          owner?.kind !== "owned" ||
          owner.user.id !== initiatingUser.userId
        ) {
          return {
            linked: false,
            error: { code: "identity_binding_conflict" },
          };
        }
      } catch {
        return { linked: false, error: { code: "identity_binding_conflict" } };
      }
      return linked;
    },
  );
}
