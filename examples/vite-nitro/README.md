# Vite + Nitro v3 playground

A runnable DiscourseConnect consumer using Vite, **Nitro v3**
(`nitro@3.0.261103-rc`, not Nitro v2's `nitropack`), Better Auth 1.7.18,
and Node.js's built-in persistent SQLite. The browser UI exercises:

- Discourse sign-in, including first-time local user creation and returning users.
- Local session inspection, linked-account inspection, and local sign-out.
- Optional email/password accounts and explicit Discourse identity linking.
- Callback errors, displayed when Discourse returns to the playground.

This is a development playground, not a production application. No email
verification or password-reset delivery is configured. Use throwaway accounts.

## Run

Use Node.js **24+** and the pnpm version pinned in the repository. From the
repository root:

```sh
pnpm install
cp examples/vite-nitro/.env.example examples/vite-nitro/.env
openssl rand -base64 32
```

Edit `examples/vite-nitro/.env`:

- Set `BETTER_AUTH_SECRET` to the generated random value.
- Set `DISCOURSE_URL` to your Discourse site's root URL, without a subpath.
- Set `DISCOURSE_CONNECT_SECRET` to the shared provider secret configured below.
- Leave `BETTER_AUTH_URL=http://localhost:3000/api/auth` for the default setup.

Then run these separately, from the repository root:

```sh
pnpm example:migrate
pnpm example:dev
```

Open **http://localhost:3000**. Vite serves the browser app and Nitro serves
`/api/auth/**` on the same origin; no proxy or CORS configuration is needed.
The dev server fails rather than silently choosing another port. Do not switch
between `localhost` and `127.0.0.1`: the origin and cookies must stay consistent.

The root convenience commands build the local plugin first. The example consumes
the workspace package's public server/client exports, not aliases to its source.
After changing plugin source, restart `pnpm example:dev` to rebuild it.

## Configure your Discourse identity provider

In Discourse's admin site settings:

1. Enable **enable discourse connect provider**. This makes Discourse the
   identity provider; do not configure it as a DiscourseConnect consumer instead.
2. Add an entry to **discourse connect provider secrets** whose domain pattern
   matches the consumer's return host (`localhost` for this setup), with the
   same secret as `DISCOURSE_CONNECT_SECRET`. Avoid wildcard domain patterns.
3. The exact return URL sent by this example is
   `http://localhost:3000/api/auth/discourse/callback`.

See the [official provider guide](https://meta.discourse.org/t/discourseconnect-provider-guide/32974).
Discourse redirects the **browser**, so the return URL must be reachable by
your browser, not necessarily by the Discourse server. If your provider requires
a public HTTPS consumer, use a tunnel, update the provider's domain entry and
`BETTER_AUTH_URL` to that HTTPS origin plus `/api/auth`, and configure Vite's
`server.allowedHosts` with that specific tunnel hostname. Do not disable host
checks globally. Restart after changing `.env`.

## Test the flows

### Discourse sign-in

1. Click **Sign in with Discourse** and authenticate on your Discourse site.
2. After the callback, inspect the local user and `discourse` linked account.
   Discourse email remains `emailVerified: false`.
3. Sign out locally, then sign in with Discourse again. The stable external
   identifier should resolve to the same local user.

Local sign-out does not sign you out of Discourse; a repeat sign-in may return
immediately if your Discourse session is still active.

### Explicit account linking

1. Set `DISCOURSE_TRUST_FOR_LINKING=true` in `.env` and restart the server.
   This explicitly enables Better Auth's linking policy and trusts `discourse`;
   it is off by default. Review [the security guide](../../docs/security.md)
   before enabling this outside a disposable test environment. Trust is **not**
   email verification, and can also affect matching-email sign-in resolution.
2. Create a local account with the **same email** as the Discourse identity you
   want to link. Use an identity that is not already owned by another local
   user (or a fresh SQLite database).
3. While signed in locally, click **Link Discourse to this local user**.
4. After returning, check that the local user ID is unchanged and the linked
   accounts include both `credential` and `discourse`.
5. Sign out locally, then sign in with Discourse. You should get the same local
   user ID again.

The example does not enable `allowDifferentEmails`. Linking an identity already
owned by another local user is rejected; it never transfers identity ownership.

## Database and migrations

`SQLITE_PATH` defaults to `./data/auth.sqlite`, relative to `examples/vite-nitro/`
when using the provided commands. Its parent directory is created automatically.
The `.env`, database directory, and generated build files are ignored by Git.

`pnpm example:migrate` explicitly applies Better Auth's schema **and** the
plugin's transaction/identity-guard schemas using `getMigrations(auth.options)`.
Re-run it after changing the schema or plugins. Migrations do not run on server
startup or in HTTP handlers. Back up any database you care about before migrating.
For a fresh test, stop the server and point `SQLITE_PATH` at a new file, then
run migrations again.

## Build, start, and verify

From the repository root:

```sh
pnpm example:build
pnpm --dir examples/vite-nitro start
```

The production server reads `.env` through Node's `--env-file` flag and listens
on port 3000 by default. It uses the same SQLite file as development. Build
output is `.output/`; keep the writable database outside it.

```sh
pnpm --dir examples/vite-nitro typecheck
pnpm build
pnpm --dir examples/vite-nitro test
```

The HTTP smoke tests build the example and exercise both Vite dev and the
production Nitro server against temporary SQLite databases, including signed
callbacks, cookie forwarding, local sign-out, and explicit linking. They use
locally signed provider responses, **not a real Discourse instance**. They do not
require `.env` and never modify your playground database. Real-provider verification
still requires the manual flow above.

For a quick health check while the server is running, visit
`http://localhost:3000/api/auth/ok` (expected `{"status":"ok"}`). If auth requests
fail, check the server console, `.env`, and migrations first. `INVALID_STATE`
usually means the browser lost its transaction cookie, the origin changed, or
the callback was expired/replayed. Callback query strings contain signed
identity data; do not share them in logs or screenshots.
