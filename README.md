# better-auth-discourse

DiscourseConnect sign-in and explicit account linking for Better Auth 1.7.18.
The package is framework-independent and separates its server and client
exports.

## Install

```sh
npm install better-auth@1.7.18 better-auth-discourse
```

Better Auth is a peer dependency; applications should install the pinned
`better-auth@1.7.18` release explicitly.

## Database migration

Transaction state and identity guards use Better Auth's configured database
adapter; the plugin does not open a separate SQLite database. SQLite in the
examples is a host configuration choice, not a plugin requirement. Other adapters
must provide atomic consumption and unique guard keys; compatibility has only
been verified against Better Auth's SQLite adapter.

The server plugin contributes schema for persistent Discourse transaction state
and identity-ownership guards. Better Auth itself contributes its standard
`user`, `session`, `account`, and `verification` models. Apply migrations for
**both** Better Auth's schema and the plugin's schema before enabling the
plugin, using the migration workflow for your chosen Better Auth database
adapter. Do not create only the standard Better Auth tables or omit the plugin
models. For the built-in SQLite adapter shown below, pin and install the CLI
matching Better Auth, then run its migration command **as a deployment step**:

```sh
npm install --save-dev auth@1.7.18
npx auth migrate --config ./examples/server.ts
```

This runs Better Auth's migration workflow against the database and plugin
schemas produced by that configuration. Inspect/review the migration effects
and ensure `SQLITE_PATH` names the intended persistent database before applying
it. Never run schema migrations automatically as part of an auth request or
application handler. For another supported adapter, use its documented
`auth generate` workflow and apply the resulting migration with that adapter's
normal migration tooling.

## Server setup

```ts
import { betterAuth } from "better-auth";
import { DatabaseSync } from "node:sqlite";
import { discourse } from "better-auth-discourse";

export const auth = betterAuth({
  database: new DatabaseSync("./data/auth.sqlite"),
  baseURL: process.env.BETTER_AUTH_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  plugins: [
    discourse({
      discourseURL: process.env.DISCOURSE_URL!, // site root, e.g. https://community.example.com
      secret: process.env.DISCOURSE_CONNECT_SECRET!,
      disableSignUp: false, // New local sign-up is allowed by default.
      overrideUserInfoOnSignIn: false, // Existing profiles are preserved by default.
      mapProfileToUser: (profile) => ({
        name: profile.name,
        image: profile.image,
      }),
    }),
  ],
  // If explicit linking is an application requirement, configure its policy
  // deliberately. See the security warning below before enabling this.
  // account: { accountLinking: { enabled: true, trustedProviders: ["discourse"] } },
});
```

`BETTER_AUTH_URL` must be the complete Better Auth base URL, including its
configured base path (for example `https://app.example.com/api/auth`). The
plugin derives its callback from that configuration; configure the identity
provider's return URL to exactly that base URL plus `/discourse/callback`.
Do not append `/api/auth` a second time when the base URL already includes it.
Keep the Discourse secret on the server only. For the identity-provider side,
see [Discourse's DiscourseConnect provider guide](https://meta.discourse.org/t/discourseconnect-provider-guide/32974).

### Trust and identity policy

The plugin does **not** add Discourse to Better Auth's trusted providers or
change your host account-linking policy. Better Auth's account-linking settings
are independent: if your application enables linking and trusts `discourse`,
this plugin's explicit `link` flow can use that configuration. Do so only after
reviewing the security implications in [the security guide](docs/security.md).
Discourse provider email is unverified (`emailVerified: false`) and must never
be treated as proof of email ownership; trust is not email verification.
Email/username changes do not change stable Discourse identity. New local
sign-ups are allowed by default (`disableSignUp: false`); the server-only
`disableSignUp` setting cannot be changed by client input. Mapping and
`overrideUserInfoOnSignIn` (default `false`) are server-controlled; only map
fields your application intends to store, and enable profile overwrites only
after reviewing those fields.

### Available profile data

`mapProfileToUser` receives `id`, `email`, `name`, `image`, `username`, `bio`,
`location`, `title`, `website`, `groups`, `admin`, `moderator`,
`profileBackgroundURL`, `cardBackgroundURL`, `confirmed2FA`, and
`no2FAMethods`. Only `id`, `email`, and the resolved display `name` are required;
the remaining fields are optional. Discourse only sends role/group and
background claims when configured to do so, and 2FA claims depend on the
provider's authentication flow. Standard DiscourseConnect does not necessarily
send bio, location, title, or website. A missing claim remains `undefined`;
`groups: ""` is normalized to `[]`, otherwise groups are comma-split without
changing case or spelling.

The seven newly exposed fields are not automatically stored or used to grant
local privileges. They are available to the mapping callback, and recognized
wire claims also accompany the provider profile passed to Better Auth. Existing
name/avatar mapping is unchanged. For example, map trusted provider groups to
an application-owned field using an explicit allowlist, preserving absence:

```ts
mapProfileToUser: (profile) => ({
  ...(profile.groups !== undefined
    ? {
        forumGroups: profile.groups.filter((group) =>
          ["Staff", "Trust Level 2"].includes(group),
        ),
      }
    : {}),
}),
```

Define `forumGroups` as an application additional user field if it should be
persisted. Existing users are updated only when `overrideUserInfoOnSignIn` is
enabled. Provider claims are snapshots, not continuous synchronization:
absent claims do not revoke existing values, and changes take effect only when
the application explicitly refreshes/maps them. Plan revocation and refresh
behavior in the consuming application. The 2FA fields are metadata from this
provider exchange, not local MFA assurance; this plugin does not request
`require_2fa` or mark the local session MFA-authenticated. No migration is
needed unless the consuming application elects to add its own storage fields.

## Client setup

```ts
import { createAuthClient } from "better-auth/client";
import { discourseClient } from "better-auth-discourse/client";

export const authClient = createAuthClient({
  baseURL: "https://app.example.com/api/auth",
  plugins: [discourseClient()],
});

// Browser calls navigate to the returned Discourse authorization URL.
await authClient.signIn.discourse({ callbackURL: "/dashboard" });

// Requires an authenticated local session; this is explicit linking, not sign-in.
await authClient.discourse.link({ callbackURL: "/settings/accounts" });
```

Both methods use Better Auth's client fetch pipeline. In a browser, its default
redirect handling navigates when the server returns `{ url, redirect: true }`.
On a server, no browser navigation occurs: check `data`/`error` and use
`data.url` in your own response or hand it to the browser. The initiating
request must reach the browser with the transaction-binding `Set-Cookie` header
from Better Auth; if your server renders or proxies the call, forward the
response cookies as well as the authorization URL. Returning only `data.url`
without setting that cookie will cause the callback's browser binding check to
fail. Relative callback URLs such as `/dashboard` are supported.

Expected endpoint errors follow Better Auth's `{ data, error }` convention;
linking without an active local session returns `SESSION_REQUIRED`. Sign-in and
link initiation can also return `INVALID_REQUEST` when destinations or request
parameters are rejected. Do not expose internal server exceptions to clients.

## Runtime support and verification

The package requires Node.js `>=24`; Node.js 24 is the tested runtime floor for
this release with Better Auth 1.7.18. This is not a claim of a tested matrix
across all database adapters or dialects. The project
does not claim real-Discourse verification until a configured production-like
Discourse instance has been exercised; consult the release checklist before
shipping.

## Development

Use Node.js 24+ and the pnpm version pinned in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm validate:package
```

`pnpm build` uses [tsdown](https://tsdown.dev/) to clean and rebuild `dist/`
with ESM bundles, TypeScript declarations, and source maps for the server,
client, and SQLite entry points. Runtime and peer dependencies stay external.
Type checking is a separate `pnpm typecheck` step; `validate:package` builds and
checks the packed exports, consumer types, and client/server isolation.

## Publishing

Maintainers: see [Publishing to npm](docs/publishing.md) for the GitHub Release
workflow, trusted publisher setup, and release gates.

## Integration examples

For a runnable browser playground, see
[`examples/vite-nitro/`](examples/vite-nitro/README.md). It uses Vite with Nitro v3,
persistent SQLite, and a UI for Discourse sign-in, local sessions, sign-out,
and opt-in explicit linking. Its README covers environment setup, migrations,
Discourse provider configuration, and development/production commands.

See [`examples/server.ts`](examples/server.ts) for server-only configuration
with persistent Node.js built-in SQLite, and [`examples/client.ts`](examples/client.ts)
for the browser-only client using the public client export. The server config
exports Better Auth's actual `auth.handler`; after migration and configuration
of a real Discourse provider, these client actions exercise the sign-in and
explicit-link flows. Neither example claims a live Discourse test has been
performed. See the [release checklist](docs/release-checklist.md) before
shipping.
