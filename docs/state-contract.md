# Transaction-state contract

`src/state.ts` intentionally separates protocol transaction state from HTTP
cookie handling. Endpoints create the browser secret and place it in a
HttpOnly/Secure/SameSite cookie; callbacks read that cookie and call
`consumeTransactionState` only after verifying the Discourse response and its
nonce. Do not consume state before the callback's browser binding matches.

## Persistence requirement

Better Auth 1.7.18's `ctx.context.adapter` is the relevant public endpoint
adapter, distinct from `internalAdapter`'s verification helpers. The
factory-wrapped adapter exposes `consumeOne`, whose documented contract is an
atomic conditional delete returning the row to exactly one concurrent caller.
Unlike composing a read and delete while ignoring the delete count, this
provides a supported single-use primitive. The generic `findOne` plus
`deleteMany`/affected-count strategy could also be made safe only if its
conditional delete and exact count semantics are proven; this implementation
does not depend on that composition. Compatibility was verified against the
pinned SQLite Better Auth test adapter, not every custom or third-party
adapter.

The internal `TransactionStateStorage` interface is deliberately narrow:

- `insert` persists an opaque record under unique `stateHash`.
- `consume` performs an atomic conditional delete matching state hash, browser
  binding hash, and expiry, returns the deleted record to exactly one caller,
  and returns null for mismatches/expired/missing records without consuming a
  browser-mismatch record.

The plugin uses `createBetterAuthTransactionStateStorage(ctx.context.adapter)`
from `src/storage/better-auth.ts`. Register `transactionStateSchema` from
`src/state.ts` in the Better Auth plugin's `schema` contribution so the host's
normal Better Auth migration tooling sees the `discourseConnectState` model.
Its unique `stateHash` field prevents duplicate records. Host migrations must
apply the generated schema before serving plugin endpoints. The adapter
factory deliberately requires `create` and `consumeOne`; it fails closed when
the latter is unavailable rather than downgrading to read/delete.

Storage follows Better Auth's configured database adapter. The plugin does not
provide a separate database driver or standalone SQLite storage export. The host
owns database connections and migrations. All processes/instances handling the
same callback must share the same durable storage and atomic consumption
semantics. Process-local maps/locks are not valid implementations.

Expired rows do not authenticate because `consume` filters expiry. Periodically
remove expired `discourseConnectState` records through a host-database maintenance
operation to bound table growth. Cleanup is maintenance only, not a security
control; migrations and cleanup are not authentication request work.

## Bound data and linking contract

State and browser-binding values are 256-bit Web Crypto random secrets. The
state nonce is returned to the protocol and is stored in plaintext in its
record as well as keyed by its SHA-256 hash; the browser secret itself is never
stored, only its SHA-256 hash. State records bind nonce, expiry, operation,
validated success/error destinations, initiating user ID, initiating Better
Auth session ID, and the SHA-256 hash of the initiating session bearer token.
The token itself is never persisted. On callback the endpoint must additionally
revalidate that this same session ID is still live for that user and that the
current session-token hash matches; the stored IDs/hash are context to verify,
not proof of session validity. This module does not access Better Auth or issue
cookies/sessions.

The record's HMAC integrity value detects storage tampering when the callback
uses the same server-only integrity key. Configure a stable random key shared
by all instances; rotating it invalidates outstanding transactions. Destination
validation is exposed as `validateDestination` for both HTTP endpoints and
direct server APIs. Absolute URLs must be credential-free HTTP(S) URLs on an
explicit trusted-origin allowlist; scheme-relative URLs, ASCII controls,
backslashes, and unsafe schemes are rejected. Single-slash relative paths are
resolved against a trusted origin and checked not to escape that origin before
being retained as relative paths for redirect composition.

## Reference verification

Tests use the Better Auth storage adapter with real SQLite, including two
independent Better Auth instances and database connections sharing a file. Tests
also exercise storage through real endpoint contexts. They prove one callback
winner for concurrent consumption and cover replay, browser mismatch, expiry,
missing state, tampered records, link context, and adversarial destination
normalization. No universal cross-dialect Better Auth adapter atomicity claim is
made.
