# Publishing to npm

The [publish workflow](../.github/workflows/publish.yml) runs when a GitHub
Release is **published**, not when a tag is pushed or a release draft is saved.
It checks out the release tag, runs the full CI verification sequence (including
the example and packed-package checks), and publishes `better-auth-discourse`
using npm trusted publishing (OIDC). No `NPM_TOKEN` secret is needed.

**Publishing automation is not release-readiness evidence.** Complete the
[release checklist](release-checklist.md), including the currently pending
real-Discourse checks, before publishing. Record the evidence in the GitHub
Release. The workflow cannot perform those manual checks.

## One-time setup

1. In the GitHub repository settings, create an environment named **`npm`**.
   Add required reviewers so a maintainer must approve publishing after reviewing
   the release evidence. Restrict deployment tags to `v*`, and protect release
   tags with a repository ruleset. The workflow's `environment` declaration alone
   does not configure these protections.
2. If the npm package does not exist yet, an authorized maintainer must bootstrap
   it with an initial manual publish before configuring its trusted publisher.
   From the verified release commit, use Node.js 24+ and pnpm 12.16.1, run the
   full CI sequence in `AGENTS.md`, then authenticate with `npm login` and run
   `npm publish --access public`. For a prerelease version, add `--tag next`.
   Do not publish before completing the release checklist. That version is then
   already published: do not run the workflow for it; use a new version for the
   first automated release.
3. In npm → `better-auth-discourse` → Settings → Trusted publishing, add a
   **GitHub Actions** publisher with these exact values:

   | Field                | Value                      |
   | -------------------- | -------------------------- |
   | Organization or user | `worldbeybladeorg`         |
   | Repository           | `better-auth-discourse`    |
   | Workflow filename    | `publish.yml`              |
   | Environment name     | `npm`                      |
   | Allowed actions      | Allow direct `npm publish` |

   New configurations must complete their first successful publish within two
   days; otherwise delete and recreate the expired configuration. Stage-only
   permission is insufficient because this workflow uses `npm publish`.

4. After verifying trusted publishing works, select **Require two-factor
   authentication and disallow tokens** in npm's publishing access settings.

This workflow uses a GitHub-hosted runner, Node.js 24, and npm 11 (trusted
publishing requires npm >=11.5.1). The public GitHub repository must match
`package.json`'s `repository.url` for provenance. Renaming or forking the
repository requires updating the workflow guard, package metadata, and npm
publisher configuration.

## Recording changes and bumping versions with pnpm

Use the pinned pnpm 12.16.1 from the repository root. `pnpm change` records
an intent; it does **not** immediately edit `package.json` or publish anything.

### Record a change

Run `pnpm change` for interactive prompts, or name this package explicitly:

```sh
pnpm change --bump patch --summary "Fix callback error handling" better-auth-discourse
```

Choose `patch` for fixes, `minor` for new features, or `major` for breaking
changes. Commit the generated `.changeset/*.md` file alongside the code change.
Use `--bump none` to explicitly record that a change needs no release. Select
`better-auth-discourse`, not the private `discourse-playground` example.

Inspect and validate pending intents without applying them:

```sh
pnpm change status
pnpm change check
```

### Apply the release plan

Before adopting this flow, add the following to the existing
`pnpm-workspace.yaml` so changelogs are committed to the repository:

```yaml
versioning:
  changelog:
    storage: repository
```

This matters because pnpm defaults to composing public-package changelogs at
`pnpm publish` time. Our workflow uses **`npm publish`**, which does not perform
that pnpm-specific step. Do not replace the workspace file's existing settings.

Start from a clean working tree with the change intents committed. Preview,
then apply the plan:

```sh
pnpm --filter better-auth-discourse --include-workspace-root version -r --dry-run
pnpm --filter better-auth-discourse --include-workspace-root version -r
```

The published package lives at the workspace root, so explicitly include it
and filter out unrelated projects. Review the plan before applying it: pnpm can
also pull in dependent packages when their dependency ranges require updates.

The recursive command applies pending intents, updates versions and changelogs,
and records consumed intents in `.changeset/ledger.yaml`. It creates **no git
commit or tag**. Review all generated changes, run the full CI sequence, and
commit the release changes before following the release steps below. Keep
`.changeset/` and its ledger under version control; pnpm handles intent cleanup.

**First-release exception:** pnpm checks the registry. If the version currently
in `package.json` has not been published, it keeps that version for the first
release rather than incrementing it. Inspect the actual plan and resulting
version; do not assume a `patch` intent always increments `0.1.0` to `0.1.1`.

References: [`pnpm change`](https://pnpm.io/cli/change),
[`pnpm version`](https://pnpm.io/cli/version), and
[pnpm release management](https://pnpm.io/versioning).

## Each release

1. Apply the pnpm release plan above, then commit the intended `package.json`
   version, changelog, ledger, and all release changes. The workflow does not
   bump versions, consume change intents, commit changes, or create tags.
2. Complete the release checklist for that commit and prepare release notes
   containing the evidence.
3. Create a tag exactly matching `v<package.json version>`, such as `v0.1.0`,
   and publish a GitHub Release for that tag:
   - Stable version, e.g. `0.1.0`: do **not** mark it as a prerelease. npm gets
     the `latest` dist-tag.
   - Prerelease version, e.g. `0.2.0-beta.1`: mark the GitHub Release as a
     prerelease. npm gets the `next` dist-tag, leaving `latest` unchanged.
4. Review the commit and release evidence, approve the `npm` environment job,
   and confirm the workflow and npm provenance succeed.

Tag/version or prerelease-status mismatches fail before publishing. Drafts and
ordinary pushes never publish. Publishing an already-existing npm version fails;
if a publish succeeded, do not rerun it or reuse its version. Promoting a GitHub
prerelease later does not move npm dist-tags; publish a new stable version instead.

Reference: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
