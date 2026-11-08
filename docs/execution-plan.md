# Coordinated implementation

This breaks [the implementation plan](implementation-plan.md) into bounded
`plan-implementor` assignments. The coordinator owns sequencing, shared contracts,
integration, and final validation. Implementors report changed files, checks run,
open risks, and handoff contracts; they do not commit changes.

## Work packages

| Package                          | Scope and ownership                                                                                                                        | Prerequisites                       | Completion gate                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Foundation and compatibility | Package manifest/lockfile, build configuration, export placeholders, compatibility tests and database harness, `docs/integration-seams.md` | None                                | Agreed Better Auth version is available; exported integration seams and database guarantees are verified, or blockers are reported           |
| B — Protocol                     | `src/protocol.ts`, protocol tests and reference fixtures                                                                                   | Independent; test execution needs A | Exact-text HMAC verification precedes claim parsing; malformed, duplicate, oversized, tampered, and failed responses are rejected            |
| C — Identity policies            | `src/identity.ts`, identity policy tests                                                                                                   | A; agreed profile contract from B   | Real-database policy matrix covers stable identity, creation, linking, profile updates, hooks, and concurrent ownership conflicts            |
| D — Transaction state            | `src/state.ts`, state tests                                                                                                                | A                                   | Persistent single-use consumption is proven under races; browser, expiry, operation, destinations, and initiating session are bound          |
| E — Server composition           | `src/index.ts`, `src/types.ts`, `src/endpoints/`, endpoint integration tests                                                               | B, C, D                             | HTTP and direct API redirect validation; no session before successful policy checks; revoked linking sessions rejected                       |
| F — Client and example           | `src/client.ts`, client type tests, `examples/`                                                                                            | E's stable endpoint contract        | Inferred sign-in/link API, Better Auth fetch behavior, browser navigation and server-side URL handling work through package exports          |
| G — Release readiness            | Usage/security documentation, CI, package-validation checks, full integration coverage, real-instance checklist                            | E, F                                | Automated checks pass; exports/types and client isolation verified; real-Discourse check remains explicitly pending until actually performed |

## Dispatch order

1. Dispatch A and B concurrently with disjoint file ownership. B is independent
   protocol work, not authentication built on unverified Better Auth semantics.
2. Review A's evidence before dispatching C and D concurrently. Resolve storage
   atomicity and supported policy adaptation before accepting either design.
3. Freeze shared contracts, then dispatch E. Only one implementor owns shared
   exports and configuration at a time.
4. Dispatch F and independent documentation/checklist portions of G concurrently.
5. Integrate, run the complete suite, and dispatch targeted follow-up fixes as
   needed. Record limitations rather than weakening acceptance criteria.

## Coordinator gates

- Do not substitute another Better Auth release line if 1.7.18 is unavailable.
- Do not assume a read/delete state implementation is atomic across instances.
- Do not infer verified email from a Discourse signature or activation field.
- Do not trust Discourse automatically or treat ordinary sign-in as explicit linking.
- Do not allow mapping to change identity binding or bypass additional-field rules.
- Do not claim real-Discourse release verification from mocks or local fixtures.
- Preserve existing user work and keep agent file ownership non-overlapping.

## Handoff status

**Final coordinator validation:** 84 tests pass across 10 test files;
typecheck, build, packed public imports/declarations/client inference and
client-isolation validation, and `git diff --check` pass. The independent
read-only audit reported no concrete security or specification defect.
Better Auth is pinned to 1.7.18; the supported Node floor is 24.
No real-Discourse check or publication has been performed.

- A: Package scaffold and real-SQLite compatibility tests delivered; dependency
  is pinned to 1.7.18. Verification read-then-delete was characterized as unsafe
  for concurrent consumption. State work must resolve this limitation explicitly.
- B: Protocol implementation and boundary-test follow-up delivered. Implementor
  reports 15 passing focused tests and a passing typecheck; coordinator reviewed
  the initial implementation and requested the additional boundary coverage.
- C: Identity policies and persistent uniqueness-backed serialization complete.
  A fresh real-SQLite harness verifies failed create/update hooks and missing
  required fields do not authenticate and release the durable guards.
- D: State hardening and production stores delivered. The exposed Better Auth
  adapter's atomic `consumeOne` supports default host-database storage through
  `transactionStateSchema`. The optional standalone Node SQLite storage was later
  removed; the state behavior tests now exercise Better Auth-managed storage.
  Coordinator independently reran state/storage tests at delivery: 14 pass.
  Plugin schema migration and endpoint wiring remain part of E.
- E: Complete with 18 passing endpoint tests, including expiry, ownership
  conflicts, replaced sessions, redirect rejection, persistent-database
  configuration, explicit error codes, and deterministic signature tampering.
- F: Typed client, inference/runtime tests, persistent SQLite server example,
  separate browser example, and README delivered; focused checks pass.
- G: Security documentation and real-Discourse release checklist delivered and
  reviewed. Real-instance checks explicitly remain pending. Package tooling,
  automated package validation and Node 24 CI delivered. Packed public imports,
  client inference/rejected inputs, and client isolation pass the strengthened
  validator. Declared Node floor now matches the tested Node 24 release line.
  Error-catalog documentation and final automated validation are complete.
- Final read-only integrated security/spec audit complete; no concrete findings.

The only remaining release gate is operator verification of sign-in and explicit
linking against a real Discourse site, following `docs/release-checklist.md`.
Crash-left identity guards require the coordinated recovery procedure documented
in `docs/security.md`; other database adapters require compatibility verification.
