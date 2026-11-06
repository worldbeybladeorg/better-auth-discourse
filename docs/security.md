# Security and operations

This integration authenticates a **local user** through a configured Discourse
identity provider using DiscourseConnect. Treat the Discourse site and its
administrator-configured shared secret as part of the authentication boundary.
Do not describe this protocol as OAuth or OpenID Connect.

## Identity and email trust boundary

- A Discourse identity is keyed by the configured provider ID and exact string
  `external_id`. Email address and username are profile data, not stable
  identity keys. Changing either must not select a different local user.
- The server maps Discourse email to `emailVerified: false`. The signed payload
  authenticates its source and integrity; it does not prove control of the
  email inbox. In particular, absent or false `require_activation` is not an
  email-verification assertion.
- Discourse is not automatically added to Better Auth's `trustedProviders`.
  Email collisions must follow Better Auth's configured linking policy and
  verification requirements. Explicitly trusting a provider is an application
  security decision and can permit account linking based on that provider's
  assertions; assess the risk before enabling it.
- Ordinary sign-in never means explicit linking to whichever local user happens
  to be signed in. Explicit linking requires the initiating local session to
  remain valid through callback. Linking must not replace the local email or
  its verification state.
- Changing `discourseURL` changes the identity provider and is an
  **identity-boundary change**, not an ordinary URL/configuration update. It
  may cause identities to resolve differently or leave old accounts linked.
  Plan a controlled migration and review account ownership before changing it.

## Secrets, protocol, and sessions

- Keep the DiscourseConnect shared secret and state-integrity key server-side in
  a secret manager or protected environment configuration. Never expose them in
  client bundles, public configuration, diagnostics, or issue reports. Use a
  distinct high-entropy secret per Discourse/consumer pairing and rotate it
  deliberately; rotation can invalidate in-flight transactions.
- Callback handling must verify the HMAC over the exact received encoded
  payload before decoding claims, validate transaction nonce and browser
  binding, and consume state once. Invalid, replayed, expired, or mismatched
  callbacks must not issue a local session.
- State binds operation, browser, expiry, validated destinations, and (for
  linking) initiating user/session. The session must be revalidated at callback;
  stored IDs or hashes alone do not prove it is still live.
- Local application sessions and Discourse browser sessions are independent.
  Signing out of either does not automatically revoke the other. Remote logout
  and synchronized revocation are not provided.
- Redirect destinations must be validated against the application's trusted
  origins, including when APIs are called directly rather than through HTTP.

## Persistent storage and stale identity guards

Apply the host's normal Better Auth migration before enabling endpoints. The
plugin contributes two plugin-owned models:

- `discourseConnectState` stores single-use transaction records. Its storage
  adapter must provide atomic conditional consumption. The default Better Auth
  implementation requires `consumeOne`; do not replace it with read-then-delete
  or a process-local map/lock. SQLite compatibility was tested against the
  Better Auth 1.7.18 test adapter, not every custom adapter or SQL dialect.
- `discourseIdentityGuard` serializes identity/email ownership operations using
  unique lock keys and owner tokens. The current implementation deliberately
  has no lease expiry or automatic age-based reaping. A stale row blocks the
  matching identity operation (fail closed).

**Stale-guard recovery is a coordinated outage procedure:** stop **all writers**
that can perform identity resolution/linking against the affected database,
including every application process/replica/worker. Confirm no operation is in
flight, inspect the exact `lockKey`/owner row, and only then remove the stale row
through the host database. Restart writers after cleanup and verify normal
operation. Do not remove a row while writers are running, and never use row age
alone as proof it is safe to remove: `ownerToken` is a random per-operation
token, not a process identity or liveness signal; there is no TTL reaper. A
paused writer could resume after an unsafe deletion and violate serialization.
Follow backup/change-control policy and retain an audit record without exposing
user identifiers unnecessarily.

Expired transaction state cannot authenticate because consumption checks
expiry. Periodically clean expired state rows using a deployment-appropriate
maintenance operation to bound storage growth; cleanup is maintenance, not a
security control. Keep all instances on the same durable state and identity
guard database. Do not use per-worker or ephemeral storage for shared flows.

## Safe diagnostics and privacy

Expected HTTP failures expose `code` and a generic `message`. The server export
`DISCOURSE_ERROR_CODES` lists `INVALID_REQUEST`, `SESSION_REQUIRED`,
`INVALID_RESPONSE`, and `INVALID_STATE`; its key type is `DiscourseErrorCode`.
After verified state is consumed, callback failures redirect to the stored error
destination with an `error` query value: `SESSION_INVALID`, `LINK_FAILED`,
`SIGN_IN_FAILED`, or `AUTHENTICATION_FAILED`. Before state verification, errors
do not redirect to caller-supplied destinations. Protocol and identity errors
remain internal; never expose their underlying credential or claim values.

For diagnostics, record only what is needed to correlate an event, such as a
timestamp, deployment/version, sanitized route, outcome, and a documented stable
error code. Never log or persist in diagnostic output:

- the shared secret, state-integrity key, cookies, session bearer tokens, or
  browser-binding secret;
- complete callback URLs/query strings, signed `sso` payloads, signatures,
  nonces, or raw state records;
- email addresses, names, usernames, avatar URLs, or full Discourse claims
  unless separately justified, minimized, access-controlled, and retained under
  the application's privacy policy.

Avoid putting sensitive values in analytics, traces, exception-reporting
breadcrumbs, support screenshots, or CI artifacts. Sanitize callback query
parameters at reverse proxies and observability agents as well as in the
application. Retain transaction data only as long as required for expiry and
cleanup; protect database backups and restrict operational access to them.

## Compatibility boundary

The recorded compatibility baseline is Better Auth **1.7.18**, with real-SQLite
adapter tests. The package declares Node.js `>=24`; optional built-in SQLite
storage requires Node.js 22.13+ and is tested on Node 24. These statements are
not a guarantee for untested Better Auth versions, Node releases, SQL dialects,
custom adapters, or real Discourse deployments. The real-instance checklist in
[`release-checklist.md`](release-checklist.md) remains **PENDING** until an
operator completes it against a recorded Discourse version/build.
