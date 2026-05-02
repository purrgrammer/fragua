---
title: Doc-vs-code drift CI lint
summary: "Doc-vs-code drift CI lint"
status: shipped
maturity: specified
last-reviewed: 2026-05-01
---

# Doc-vs-code drift CI lint

> AGENTS.md ground rule #1 says "touching `<contract file>` requires a
> same-PR doc update." Today this is hortatory — there's no
> enforcement. The audit conducted this session found 14
> CRITICAL/HIGH/MEDIUM drift findings in `ARCHITECTURE.md` alone.
> Without a gate, the same drift will return.

## Shape

A `bun run lint:docs` target wired into `bun run ci`:

1. **Schema lint.** Parse `packages/store/src/schema.sql`. Assert every column / index / table also appears in `docs/ARCHITECTURE.md` §2 (regex-based; tolerates whitespace + comments).
2. **Event taxonomy lint.** Parse `packages/types/src/swarm-events.ts`. Assert every `IntentEvent` / `FactEvent` / `DaemonEvent` type, every `HaltReason` / `QuarantineReason` / `RunStatus` value, appears in `docs/ARCHITECTURE.md` §3.
3. **Handler-contract lint.** Parse `packages/core/src/handler/types.ts`. Assert the `HandlerResult` halt-reason enum matches `docs/handler-contract.md`.
4. **Proposal-index lint.** Cross-check `docs/proposals/README.md` index against actual `docs/proposals/*.md` files: each file present in index; index entry's status / maturity matches file front-matter.
5. **Capability claim lint.** For each `status: shipped` proposal, verify the README "What swarm delivers today" section claims a capability whose phrasing matches the proposal's front-matter `summary` (preferred) or `title`.

Failures print a unified diff between the discovered surface and the documented one.

## Why this is load-bearing

Without enforcement, AGENTS.md rule #1 is a Schelling point that the next inattentive PR breaks. The audit this session was a manual reconstruction of what a lint would tell you in 50 ms.

This proposal pairs with [`introspection-workflow`](./introspection-workflow.md): the lint is the *structural* enforcement (pass/fail in CI); the workflow is the *narrative* counterpart (prose suitable for release-readiness review). One catches drift early and cheaply; the other surfaces qualitative findings that no lint can.

## Open questions

- **False positives on intentionally-private internals.** If the schema gains an `internal_` prefix column that's deliberately undocumented, the lint should accept a `// @drift-ignore` annotation on that line.
- **Granularity of structural compare.** "Column appears in §2" is loose — does `id INTEGER` match `id TEXT` in the doc? Tighten over time; ship loose-then-strict.
- **Where to store the parsed expectation.** AST → JSON intermediate files are cheaper than re-parsing per CI run, but require commit hygiene for the snapshot. Start with re-parse-each-run; optimise if CI time becomes a problem.

## What this does not commit to

- **Auto-fixing drift.** Lint reports; humans fix. Auto-generated docs are worse than stale docs because they hide intent.
- **Catching semantic drift** (e.g., a column whose meaning changed but name didn't). Out of scope; structural only.
- **Replacing the front-matter discipline in proposals.** Adds a check that the README index matches reality.

## Implementation notes

Landed as `bun run lint:docs` (driven by `packages/store/test/lint-docs.test.ts`) and woven into `bun run ci` between `lint` and `typecheck`. Suppression is line-based: a `-- drift-lint: ignore` line in `schema.sql` directly above a column declaration, or a `// drift-lint: ignore` line in a TS contract file directly above a union member, exempts the next declaration from the audit. No AST. The fixture pair under `packages/store/test/fixtures/drift-lint/` proves the lint catches real drift — a parameterised self-test asserts the drifted fixture surfaces the missing column by name and the clean fixture yields zero findings.

The capability-claim audit (item 5 in the original shape) ships in the same gate: `auditCapabilityClaims` walks every `status: shipped` proposal and asserts the README "What swarm delivers today" section contains its front-matter `summary` (falling back to `title`). Suppression for the capability audit is `// drift-lint: ignore <basename>.md` on its own line within the README section.
