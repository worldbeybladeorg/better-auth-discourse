# Repository guidance

## Context

- Before exploring, read `docs/agents/domain.md` for glossary/ADR conventions.
- For issues/specs, use GitHub Issues in `worldbeybladeorg/better-auth-discourse`;
  read `docs/agents/issue-tracker.md` before tracker operations and
  `docs/agents/triage-labels.md` when assigning triage labels.
- Before changing authentication, linking, or storage behavior, read
  `docs/security.md` and the relevant `docs/state-contract.md` or
  `docs/identity-contract.md`.

## Verification

- Use Node.js 24+ and pnpm 12.16.1 (pinned in `package.json`).
- Full CI sequence, from the repository root:

  ```sh
  pnpm install --frozen-lockfile
  pnpm typecheck
  pnpm test
  pnpm build
  pnpm --dir examples/vite-nitro typecheck
  pnpm --dir examples/vite-nitro test
  pnpm validate:package
  ```

- Focus a runtime test with
  `pnpm test test/endpoints.test.ts -t "registers both persistent schemas"`.
  `test/*-types.test.ts` files are compile-only: `pnpm typecheck` checks them;
  Vitest deliberately excludes them.
- Root typecheck/tests do not cover the Vite/Nitro workspace. Build the root
  package before checking that workspace: it resolves public exports from `dist/`,
  whereas root TypeScript paths resolve the plugin source.
- `pnpm validate:package` rebuilds and checks the actual tarball's imports,
  consumer declarations, and client/server isolation; source tests are not a
  substitute for this check when changing exports or the build.

## Package boundaries

- `src/index.ts` composes the server plugin's endpoints and both plugin schemas.
  `src/client.ts` is a separate browser entry: keep its server imports type-only.
  Transaction state and identity guards use the host Better Auth database adapter.
- Better Auth compatibility is pinned to 1.7.18. For dependency upgrades, consult
  `docs/integration-seams.md` and `test/better-auth-compat.test.ts`; passing SQLite
  tests is not evidence for other adapters or real Discourse deployments.

## Playground

- Read `examples/vite-nitro/README.md` before running the interactive example.
  Configure its `.env`, then run `pnpm example:migrate` before `pnpm example:dev`.
  Migrations include Better Auth and plugin schemas and are explicit setup steps,
  not server-startup/request work.
- Root `example:*` commands rebuild the plugin; restart `pnpm example:dev` after
  plugin source changes because the playground does not consume source aliases.
- Playground smoke tests build the example and launch dev/production HTTP servers
  with temporary SQLite databases and locally signed callbacks. They need no
  `.env` or live Discourse instance and do not verify a real provider.
- Before claiming release readiness, follow `docs/release-checklist.md`; its
  real-Discourse verification gate is still pending.
