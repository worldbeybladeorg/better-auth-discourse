# Issue tracker: GitHub

Issues and specs live in `worldbeybladeorg/better-auth-discourse`.
Use the `gh` CLI from this repository.

## Conventions

- Create: `gh issue create --title "..." --body "..."`
- Read: `gh issue view <number> --json number,title,body,labels,comments`
- List: `gh issue list --state open`, with appropriate label filters.
- Comment: `gh issue comment <number> --body "..."`
- Labels: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- Close: post an explanation with `gh issue comment`, then `gh issue close`.
- Use native sub-issues and issue dependencies when available.
  Otherwise, put `Part of #<parent>` and `Blocked by: #<number>` at
  the top of child issue bodies. A ticket is unblocked when all blockers
  are closed.

Before the first issue creation in a session, verify the target with
`gh repo view --json nameWithOwner`. File issues only in this repository.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Skill instructions

- "Publish to the issue tracker" means create a GitHub issue.
- "Fetch the relevant ticket" means read the GitHub issue.
