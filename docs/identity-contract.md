# Identity helper contract

`resolveDiscourseIdentity(ctx, claims, policy)` and `linkDiscourseIdentity(ctx,
claims, initiatingUser, policy)` are internal server integration seams. The
policy requires a durable `identityLockStorage`; omitting it is a type error.
Server composition should register `identityGuardSchema` and construct
`createBetterAuthIdentityGuard(ctx.context.adapter)` per endpoint request. They use
the public `handleOAuthUserInfo` and `linkOAuthAccount` helpers from the pinned
Better Auth version. The Discourse account key is `(providerId: "discourse",
accountId: claims.external_id)`; `external_id` remains an exact string. Claims
always set `emailVerified: false` and do not add `discourse` to trusted providers.

## Policy behavior

- Known provider identities use the account key, not email or username. A
  post-helper ownership read verifies that the returned session user owns that
  key; ambiguous or mismatched ownership fails closed with no returned session.
- `disableSignUp` is passed to Better Auth for unknown identities. Existing
  bound identities continue to resolve.
- Implicit linking remains subject to Better Auth's `enabled`,
  `disableImplicitLinking`, provider trust, local email verification, and
  unverified-provider-email checks.
- Explicit linking targets the supplied initiating user. Better Auth enforces
  linking enabled, provider trust, and `allowDifferentEmails`. Local email and
  verification are not copied from claims. Repeating same-owner links and
  cross-owner conflicts use Better Auth helper results and a post-write owner
  check.
- Existing profile data is preserved by default. Sign-in updates follow
  `overrideUserInfoOnSignIn`; explicit link updates follow
  `account.accountLinking.updateUserInfoOnLink`.
- `mapProfileToUser` may customize name/image and declared additional fields,
  but cannot set email, email verification, provider/account identifiers, or
  database identity fields. Unknown additional fields are ignored. Configured
  additional-field input validators and built-in types/enums are applied before
  handing data to Better Auth.
- Better Auth database user hooks and validation remain active. A thrown hook
  does not produce a successful identity result.

## Identity serialization

The 1.7.18 public OAuth helpers perform account ownership reads and writes as
separate operations. Direct SQLite race characterization showed those helpers
alone can create multiple account rows for the same provider/account key. The
identity functions therefore require `DiscourseIdentityLockStorage` and hold
exclusive persistent locks on the provider key and normalized email across the
entire helper call. Explicit linking locks the provider key plus both local and
provider email keys. Keys are sorted before acquisition to avoid deadlocks.

`createBetterAuthIdentityGuard` uses the host's existing Better Auth database
through its factory-wrapped public `create`, `findOne`, and atomic `consumeOne`
adapter methods. Its plugin-owned `discourseIdentityGuard` model has a unique
`lockKey`; regular Better Auth schema migration provisions it. A racing two-
owner real-SQLite test confirms only one linking attempt succeeds and no
duplicate account rows are created. A custom storage implementation must
provide the same durable mutual exclusion semantics. The guard only coordinates
users of this plugin; unrelated code writing Discourse accounts directly must
follow the same contract or database uniqueness must also be enforced.

Locks deliberately have no automatic lease expiration. A process crash can
leave a persistent lock row, which blocks matching operations (fail closed).
`ownerToken` is a random per-operation token, not an OS process identifier, so
the row alone cannot prove that its owner is inactive. For recovery, stop all
plugin writers across every instance, verify no identity operations remain in
flight, then remove only the stale guard rows through the host database before
restarting writers. Never reap based only on row age: a paused process could
resume and write through Better Auth's independent adapter. This coordinated
maintenance procedure and durable custom adapter implementations remain
deployment responsibilities.

Additional fields mapped from the provider are validated by their Standard
Schema input validator when configured (including its synchronous transformed
value); otherwise the identity boundary checks Better Auth's declared scalar,
JSON, enum, and string/number-array field types. Better Auth's own OAuth parser
still applies create/update defaults, required-field checks, and input-field
filtering. Async Standard Schema validators are rejected, matching Better Auth
1.7.18's parser. `transform.input` remains delegated to Better Auth's OAuth
profile parser; custom transforms should be deterministic and compatible with
the mapped value validation.
