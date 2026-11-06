# DiscourseConnect Plugin Implementation Plan

## Goal

Build `better-auth-discourse`, a reusable TypeScript Better Auth plugin that lets a DiscourseConnect consumer sign users in through a Discourse identity provider. Better Auth manages local users, linked accounts, and local sessions.

This is an implementation plan, not an implementation. Follow the terminology in [`GLOSSARY.md`](../GLOSSARY.md).

## Agreed scope

- One administrator-configured Discourse site per Better Auth instance.
- Server plugin and typed client plugin, published as an npm package.
- Interactive sign-in, automatic local user creation, and explicit account linking.
- Persistent Better Auth database required.
- Stable provider identity matching, independent of email and username changes.
- Better Auth social/OAuth-style account-linking policy, not enterprise SSO domain verification.
- Profile mapping and opt-in profile updates following Better Auth conventions.
- Node.js as the initially tested runtime; portable APIs wherever practical.
- Automated protocol, integration, and type tests, plus a real-Discourse release check.

## Compatibility and security baseline

Start with Better Auth **1.7.18**, the published stable version verified during planning. Declare Better Auth as a peer dependency and expand the supported range only after compatibility testing. Recheck the published version before installing dependencies; do not silently change the agreed release line.

Use exported Better Auth APIs rather than private imports. Use `createAuthEndpoint` and the Better Call integration for endpoints, and Better Auth's client fetch infrastructure. The Discourse exchange uses browser redirects and does not itself require a server-to-server HTTP client.

Discourse supplies its user ID as `external_id`, but its provider response does not supply a reliable email-verification claim. Default to `emailVerified: false`. Neither a valid HMAC nor absent/false `require_activation` establishes email ownership. Do not automatically add Discourse to `trustedProviders`; applications may explicitly configure trust, subject to Better Auth's remaining linking checks.

## 1. Package foundation

Proposed layout:

```text
src/
  index.ts              Server plugin
  client.ts             Client plugin
  types.ts              Public configuration and profile types
  protocol.ts           DiscourseConnect encoding and signatures
  state.ts              Login/link transaction state
  endpoints/
    sign-in.ts
    callback.ts
    link.ts
  identity.ts           Better Auth identity integration
test/
examples/
```

Tasks:

- Configure strict TypeScript, ESM, and declaration generation.
- Define separate server and client package exports.
- Add build, typecheck, test, and package-validation scripts.
- Declare peer dependencies for directly imported Better Auth packages with compatible supported ranges.
- Keep server code, secrets, and server-only dependencies out of client bundles.
- Prefer Web Crypto, Fetch, URL, and other portable APIs where appropriate.

**Acceptance:** the package builds and its published exports/types resolve correctly; importing the client does not pull in server implementation or secrets.

## 2. Verify Better Auth integration seams

Before implementing authentication, write small compatibility tests against the pinned release's exported APIs for:

- Local user creation and returning-user resolution.
- Implicit and explicit account linking.
- Profile updates and additional-field validation.
- Session creation and cookies.
- Temporary state storage and single-use consumption.
- Applicable database hooks and authentication policy checks.

Prefer exported helpers over duplicating Better Auth's policies. Isolate any necessary adaptation in `identity.ts`. Do not represent DiscourseConnect as OAuth on the wire merely because OAuth authentication helpers are reusable.

**Acceptance:** each required behavior has a verified integration path. Identify unsupported behavior or helper semantics before building the remaining flow on top of them.

## 3. Protocol implementation

Implement independently of user/session management:

- URL-encoded query-string payload serialization and Base64 encoding.
- HMAC-SHA256 over the exact encoded payload text.
- Secure signature verification before interpreting identity claims.
- Strict response parsing, required-field checks, and payload limits.
- String-preserving handling of `external_id`.
- Unicode, escaping, malformed-input, and duplicate-parameter handling.
- Explicit failure handling rather than interpreting failed authentication as a user identity.

**Acceptance:** protocol/reference fixtures pass. Tampered or malformed responses are rejected without logging secrets or complete authentication payloads.

## 4. Sign-in state and endpoints

Proposed endpoints:

| Endpoint | Responsibility |
| --- | --- |
| `POST /sign-in/discourse` | Validate destinations, create transaction state, and return the Discourse authorization URL |
| `GET /discourse/callback` | Verify response and state, resolve identity, establish a local session for sign-in, and redirect |
| `POST /discourse/link` | Start explicit linking from an authenticated local session |

Flow:

```text
Application → plugin sign-in endpoint
            → Discourse /session/sso_provider
            → plugin callback
            → Better Auth local session
            → validated application destination
```

Transaction state must bind:

- A cryptographically random nonce and expiry.
- The initiating browser.
- The operation: sign-in or linking.
- Validated success and error destinations.
- The initiating user and session for explicit linking.

Use supported Better Auth storage facilities where suitable. Require single-use state consumption, including concurrent callbacks; verify rather than assume storage atomicity. Do not rely on process-local state for multi-instance deployments.

Validate redirect destinations for both HTTP requests and direct server API calls. Require the session authorizing explicit linking to remain valid when the callback arrives. Ordinary sign-in must never implicitly become a link to the currently signed-in user.

**Acceptance:** tests reject replay, browser mismatch, expiration, destination tampering, concurrent reuse, and invalidated linking sessions. No local session is issued before identity and policy checks succeed.

## 5. Identity and profile behavior

Use Better Auth's existing user and account models, rather than a parallel identity system.

Implement these branches:

1. **Known provider identity:** sign in the local user who owns the linked account.
2. **Unknown identity, unused email:** create the local user and linked account unless `disableSignUp` is enabled.
3. **Unknown identity, existing email:** apply the host application's Better Auth implicit-linking policy, including verification/trust requirements and supported linking switches.
4. **Explicit linking:** enforce linking settings, email policy, initiating-session validity, and ownership-conflict checks.

Resolve returning users by provider ID plus stable Discourse external ID, never by email or username. Document that changing the configured Discourse site is an identity-boundary change, not an ordinary configuration update.

Proposed server configuration:

```ts
discourse({
  discourseURL: "https://community.example.com",
  secret: process.env.DISCOURSE_CONNECT_SECRET!,
  disableSignUp: false,
  overrideUserInfoOnSignIn: false,
  // Optional: mapProfileToUser
});
```

Profile requirements:

- Populate new local profiles from validated provider data, with typed `mapProfileToUser` customization.
- Preserve existing profiles by default.
- Support opt-in `overrideUserInfoOnSignIn` behavior consistent with the supported Better Auth release.
- Honor the host's `account.accountLinking.updateUserInfoOnLink` setting.
- Linking must not replace the existing local email or its verification status.
- Profile mapping must not override the provider identity binding or bypass additional-field rules.

`disableSignUp` defaults to `false` and is enforced server-side. Client requests cannot override it. Existing linked users must remain able to sign in when it is enabled.

**Acceptance:** policy-matrix tests cover creation, returning sign-in, implicit linking, explicit linking, ownership conflicts, profile behavior, and disabled registration. Failed or concurrent operations must not produce duplicate bindings or authenticate the wrong local user.

## 6. Typed client plugin

Proposed usage:

```ts
await authClient.signIn.discourse({
  callbackURL: "/dashboard",
});

await authClient.discourse.link({
  callbackURL: "/settings/accounts",
});
```

Tasks:

- Infer endpoint inputs/results from the server plugin.
- Use Better Auth's fetch conventions and typed error handling.
- Support browser navigation and document server-side authorization-URL handling.
- Define stable, non-sensitive error codes for expected failures.
- Keep the client framework-independent.

**Acceptance:** compile-time tests validate the public API and client inference. An example application completes sign-in and explicit linking using the packaged exports.

## 7. Integration, documentation, and release

Automated coverage:

- Encoding vectors, Unicode, escaping, missing fields, and malformed responses.
- Signature tampering, nonce expiry, replay, browser mismatch, and callback races.
- First login and stable identity recognition after email/username changes.
- Linking enabled/disabled, implicit linking disabled, trust settings, and email collisions.
- Different-email policy, expired initiating sessions, and account ownership conflicts.
- Profile mapping, preservation, opt-in updates, and additional-field rules.
- Server-enforced disabled registration.
- Redirect validation through HTTP and direct server APIs.
- Applicable Better Auth hooks, session behavior, and cookie handling.
- Client type inference, package imports, and server/client separation.

Run integration tests with a real database. Before release, complete sign-in and explicit linking against a real Discourse instance; mocks alone are insufficient. The real-instance check can be a documented release check rather than a requirement for every CI run.

Documentation must cover:

- Installation and server/client configuration.
- Discourse's identity-provider settings, callback-domain configuration, and shared secret.
- Database requirements and any migration requirements discovered during implementation.
- Account linking, email trust, and the consequences of explicitly trusting Discourse.
- Profile ownership and update options.
- Errors, troubleshooting, and safe diagnostics.
- Independent Discourse and local sessions: signing out of one does not automatically revoke the other.
- Supported Better Auth versions and tested Node.js versions.

**Release gates:** automated tests pass, package exports/types validate, no secrets enter client output, and real-Discourse sign-in/linking checks succeed.

## Deferred beyond v1

- Synchronized logout and remote session revocation.
- Background profile synchronization.
- Automatic group/role or organization assignment.
- Multiple Discourse providers per Better Auth instance.
- Discourse administration APIs.
- Silent sign-in (`prompt=none`).
- Forced two-factor controls (`require_2fa`). Normal Discourse-configured authentication requirements still apply.
- Official support for untested server runtimes or database-free configurations.

## Execution order

1. Package foundation.
2. Better Auth integration-seam verification.
3. Protocol implementation and fixtures.
4. Transaction state and endpoints.
5. Identity, linking, and profile policies.
6. Typed client and example application.
7. Integration tests, real-instance verification, documentation, and release checks.

## References

- [Better Auth plugin authoring](https://better-auth.com/docs/concepts/plugins)
- [Better Auth users and account linking](https://better-auth.com/docs/concepts/users-accounts)
- [Better Auth configuration options](https://better-auth.com/docs/reference/options)
- [Official SSO provisioning behavior](https://better-auth.com/docs/plugins/sso/provisioning)
- [Discourse as an identity provider](https://meta.discourse.org/t/use-discourse-as-an-identity-provider-sso-discourseconnect/32974)
- [Discourse provider payload population](https://github.com/discourse/discourse/blob/5c954dc77fef0d7600e3a92be40acca3fab8d9e0/lib/second_factor/actions/discourse_connect_provider.rb)
- [DiscourseConnect payload handling](https://github.com/discourse/discourse/blob/5c954dc77fef0d7600e3a92be40acca3fab8d9e0/lib/discourse_connect_base.rb)

Discourse source observations were gathered during planning on November 5, 2026. Recheck behavior against the Discourse version used for release verification.
