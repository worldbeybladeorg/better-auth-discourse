# Release verification checklist

**Status: PENDING — real-Discourse verification has not been performed.**

Do not describe the package as release-ready until every applicable gate below
has evidence attached to the release record. Unit tests, mocks, and local
fixtures do not satisfy the real-instance gate. Record the exact Discourse
version/build, Better Auth version, Node version, date, and pass/fail result;
never record the shared secret or real user data.

## Automated package gates

Run from the repository root against the release commit:

- [ ] `pnpm build`
- [ ] `pnpm typecheck`
- [ ] `pnpm test` (full suite, including real-SQLite integration coverage)
- [ ] `pnpm validate:package`
- [ ] Verify package exports and declarations for server (`better-auth-discourse`)
      and client (`better-auth-discourse/client`) resolve from the packed output.
- [ ] Inspect the packed client entry and its dependency graph: no server
      implementation, shared secret, state integrity key, or other credential is
      present. Do not rely only on source-level inspection.
- [ ] Confirm host Better Auth migrations include both plugin-owned models:
      `discourseConnectState` and `discourseIdentityGuard`; apply the generated
      migration before serving plugin endpoints.
- [ ] Confirm the default Better Auth state adapter is backed by atomic
      `consumeOne` semantics. The compatibility evidence is against the pinned
      Better Auth SQLite test adapter only; do not generalize it to all adapters.
- [ ] If using optional `createSqliteTransactionStateStorage`, verify durable
      shared storage and Node `node:sqlite` availability (Node.js 22.13+; tested
      on Node 24). Do not use per-worker or in-memory production databases.

The currently declared support floor is Node.js `>=24`. Record the Node versions
actually used for build, typecheck, tests, and package validation. The optional
SQLite storage's underlying API is available from Node.js 22.13, but this package
supports Node.js 24 and newer; older runtimes are not verified. Better Auth
compatibility is pinned and tested at **1.7.18**; other Better Auth versions are
not established as supported by the recorded integration evidence.

## Real Discourse setup (operator action required)

Use a dedicated, non-production Discourse test site and test accounts. Have a
Discourse administrator configure the site using the official [Discourse
identity-provider setup guide](https://meta.discourse.org/t/use-discourse-as-an-identity-provider-sso-discourseconnect/32974):

1. In Discourse Admin → Settings, enable **Enable discourse connect provider**
   (`enable_discourse_connect_provider`).
2. Configure **Discourse connect provider secrets**. The official guide names
   the setting this way; the setting registry/API key is commonly referenced as
   `sso_provider_secrets`. Confirm the exact key and accepted value format in
   the target Discourse version's admin UI/site-setting registry; do not assume
   a key or syntax from a different version. Configure the consumer callback
   host/domain pattern permitted by that setting to match the externally
   reachable Better Auth callback URL. The return URL host must match the
   configured pattern.
3. Generate a high-entropy, unique shared secret for this test pairing. Enter
   the same value in the server-only `discourse({ discourseURL, secret })`
   configuration and Discourse's provider-secret configuration. Keep it in a
   secret manager/environment variable; do not paste it into tickets, logs,
   screenshots, this checklist, or client configuration.
4. Configure the application callback URL and trusted redirect origins. Apply
   Better Auth's generated database migration, including both plugin-owned
   models, before attempting flows.
5. Use HTTPS for externally reachable endpoints. Confirm reverse proxies retain
   the callback query string and route it to the configured Better Auth handler.

The provider guide describes the Discourse authorization path as
`/session/sso_provider`. Check the target version's current provider settings
and behavior rather than relying solely on this document or a mocked response.

## Real-instance behavior checks

Record each result as **PASS**, **FAIL**, or **NOT RUN**, with sanitized evidence
and the Discourse version/build. These are manual release gates and are all
currently pending.

- [ ] **First sign-in / signup:** authenticate a new Discourse test account;
      verify an expected local user and linked account are created, then verify
      a local session is established. Confirm the app's registration policy is
      respected. Do not infer verified email: DiscourseConnect does not provide
      a reliable email-verification claim, and `require_activation` being absent
      or false is not proof of email ownership. New users must remain
      `emailVerified: false` unless independently verified by the application.
- [ ] **Returning identity stability:** sign in again; confirm the same local
      user is resolved by provider ID plus exact stable `external_id`, not email
      or username.
- [ ] **Email/username changes:** change the test identity's email and username
      at Discourse and sign in again. Confirm the same local user is selected;
      record any expected profile update policy separately from identity
      matching.
- [ ] **Explicit linking:** while signed in to an existing local user, invoke
      the explicit link flow and authenticate as the intended Discourse account.
      Confirm the linked account belongs to that local user and the local email
      and its verification status are unchanged. Verify an identity already
      owned by another local user cannot be taken over.
- [ ] **Email collision and implicit linking:** test an unknown Discourse
      identity whose email collides with a local account. With the default
      `emailVerified: false` and no automatic Discourse trust, confirm it is not
      silently linked. Exercise the host's explicit trust/linking settings only
      as a separately documented policy decision; trust must not be assumed.
- [ ] **Different-email explicit link:** with linking configured to disallow
      different emails, confirm linking is rejected for a different email; if
      the host explicitly allows it, confirm only the external identity is
      linked and local email/verification are preserved.
- [ ] **Revoked linking session:** begin linking, revoke/sign out the initiating
      Better Auth local session before the callback, then confirm callback
      rejects the link and creates no local session as a side effect.
- [ ] **Session independence:** establish both a Discourse browser session and
      a local application session. Sign out of Discourse and verify this does
      not automatically revoke the local session. Separately sign out/revoke
      the local session and verify this does not automatically sign out the
      Discourse browser session. Synchronized/remote logout is not provided.
- [ ] **Protocol/redirect smoke test:** verify successful callback, callback
      origin/path, return redirect, failure behavior, and no secret or complete
      signed payload appears in browser-visible errors or application logs.

## Compatibility evidence versus future gates

The repository records Better Auth **1.7.18** integration tests using its real
SQLite test adapter, and optional Node SQLite state-store tests (Node 24). These
are automated compatibility evidence, not a real Discourse run, not evidence
for every database adapter/dialect, and not proof for other Better Auth or Node
versions. Capture actual CI results and the real-instance operator evidence for
each release. Until then, retain the **PENDING** status above and do not claim
release readiness.

## Official reference

- [Use Discourse as an identity provider (SSO, DiscourseConnect)](https://meta.discourse.org/t/use-discourse-as-an-identity-provider-sso-discourseconnect/32974)
- [DiscourseConnect source observations pinned during planning](https://github.com/discourse/discourse/blob/5c954dc77fef0d7600e3a92be40acca3fab8d9e0/lib/second_factor/actions/discourse_connect_provider.rb) — recheck behavior against the exact Discourse version used for the release check.
