# Better Auth 1.7.18 integration seams

## Compatibility setup

The registry was queried before install on 2026-11-05:

```text
npm view better-auth@1.7.18 version  -> 1.7.18
npm view better-auth version         -> 1.7.18
```

Both the Better Auth development dependency and peer dependency are pinned to exactly `1.7.18`. Context7 resolved Better Auth plugin/test documentation. Integration tests import only public package paths: `better-auth`, `better-auth/api`, `better-auth/oauth2`, `better-auth/cookies`, and `better-auth/test`. They exercise the exported `handleOAuthUserInfo` and `linkOAuthAccount` helpers in actual `createAuthEndpoint` request contexts. Adapter operations are invoked only through the endpoint context's exposed `internalAdapter` interface.

`corepack pnpm approve-builds better-sqlite3 esbuild` approved only the two selected build dependencies and successfully ran their lifecycle builds. Tests use `getTestInstance` from `better-auth/test`; in v1.7.18 it creates a real in-memory SQLite database with Node 24's built-in `node:sqlite` `DatabaseSync`, runs Better Auth migrations, and executes requests through `auth.handler`. This avoids native SQLite runtime requirements in CI. The `better-sqlite3` native build was also successfully completed, though it is not the test adapter.

The handwritten state-test adapter and its `better-sqlite3` dependency have since
been removed, along with the optional standalone Node SQLite storage module. The
state behavior tests now use Better Auth-managed storage, including plugin
migrations and atomic consumption across two database connections sharing a file.

## Behaviorally tested contracts

| Behavior                                          | Public seam and result                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local user/account creation and stable resolution | Endpoint context `internalAdapter.createUser`, `linkAccount`, and `findAccountByKey` persist and resolve provider ID plus exact string account ID (including leading zeroes). Repeated lookup returns the same local user.                                                                                                                                                                    |
| Implicit linking policy                           | Exported `handleOAuthUserInfo` does not link a colliding local email when the provider email is unverified. It also refuses implicit linking when `disableImplicitLinking` is true, even with provider trust and verified emails. No Discourse trust is added by these tests.                                                                                                                 |
| Explicit linking helper                           | Exported `linkOAuthAccount` links when application configuration explicitly trusts the provider and linking is enabled. With `updateUserInfoOnLink`, profile name is updated while local email and `emailVerified` remain unchanged. A configuration disabling account linking rejects the link, and an identity already owned by a different local user remains bound to its original owner. |
| Additional fields/hooks                           | A configured `user.additionalFields.forumRole` is persisted, unknown `notDeclared` input is dropped, and `databaseHooks.user.create.before` runs.                                                                                                                                                                                                                                             |
| Session/cookies over HTTP                         | Endpoint context creates a database-backed local session and exported `setSessionCookie` writes a `Set-Cookie` header; a subsequent HTTP `get-session` request carrying that cookie resolves the persisted session/user.                                                                                                                                                                      |
| Verification state                                | `createVerificationValue`, `findVerificationValue`, and `deleteVerificationByIdentifier` persist state in Better Auth's SQLite-backed verification storage. An expected-failure characterization test demonstrates the get-then-delete sequence has no single-use guarantee: two concurrent reads both observe the same state before either delete.                                           |

The tests are in `test/better-auth-compat.test.ts`. The expected-failure test
uses Vitest `it.fails`: the test itself expects exactly one state claim, while
the current adapter API produces two, so the test suite passes while preserving
a reproducible failure characterization.

## State atomicity finding and contract

**Implementation resolution:** The limitation below applies to the internal
verification helpers, not the entire exposed adapter. Subsequent tests found
the factory-wrapped `ctx.context.adapter.consumeOne` atomic primitive. The
implemented default store uses it with the plugin-owned `discourseConnectState`
schema; real SQLite tests prove one winner. See `src/storage/better-auth.ts`,
`test/better-auth-state-storage.test.ts`, and [the final state contract](state-contract.md).
No extra host storage configuration is needed. Apply plugin schema migrations.

Better Auth 1.7.18's exposed internal adapter provides separately callable
`findVerificationValue(identifier)` and `deleteVerificationByIdentifier(identifier)`;
there is no exposed atomic consume operation. The characterization above
proves that composing them as read-then-delete permits both concurrent callback
handlers to observe a valid record. This is unsupported for replay protection,
including on a single SQLite connection; multiple application instances only
make the constraint more important. Do not claim the Better Auth verification
table or storage helper is single-use.

Recommended plugin-owned persistent table and operation:

```sql
CREATE TABLE discourse_connect_state (
  state_hash TEXT PRIMARY KEY,
  browser_binding_hash TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
```

Insert an unpredictable random state (store only its hash) and bind it to a
browser-secret hash. Consume with one database-atomic conditional operation,
for example SQLite/PostgreSQL:

```sql
DELETE FROM discourse_connect_state
WHERE state_hash = ? AND browser_binding_hash = ? AND expires_at > ?
RETURNING payload, operation;
```

Exactly one concurrent caller receives a row. For dialects without
`DELETE ... RETURNING`, use a transaction with a conditional update
`SET consumed_at = now WHERE state_hash = ? AND consumed_at IS NULL AND ...`,
and accept only the call whose affected-row count is one. The internal contract
should be `consumeTransactionState({ state, browserBinding }): Promise<state |
null>` backed by a dialect-appropriate atomic primitive. Keep operation, expiry,
success/error destinations, initiating user ID, and initiating session ID in
the payload; revalidate the linking session on callback. Implementation and
cross-adapter atomicity verification remain for later state work.

## Remaining limits

- These are real SQLite tests of the pinned release, not compatibility evidence
  for additional Better Auth versions or database dialects.
- Implicit-link tests cover unverified provider email and the
  `disableImplicitLinking` switch. Additional permutations (unverified local
  email, trust policy variants, email mismatch, account ownership conflicts)
  should be retained in the identity work-package policy matrix.
- Session/cookie behavior is verified through HTTP. Session expiry, cookie
  customization, and concurrent session invalidation still need dedicated
  coverage as endpoint behavior is implemented.
- The original compatibility work did not implement production authentication.
  Those modules and their subsequent integration tests are now complete; see
  [execution status](execution-plan.md). The sample SQL above is illustrative,
  not the default Better Auth migration schema.
