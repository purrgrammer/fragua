---
title: Drift-lint extensions — HandlerContext, proposal status, retry-status JSDoc
summary: "Drift-lint extensions — HandlerContext, proposal status, retry-status JSDoc"
status: proposed
maturity: specified
last-reviewed: 2026-05-04
---

# Drift-lint extensions — HandlerContext, proposal status, retry-status JSDoc

> The 2026-05-04 introspect run found 11 CRITICAL+HIGH drift findings.
> The existing `bun run lint:docs` gate (per [`drift-lint.md`](./drift-lint.md))
> catches schema, event-taxonomy, halt-reason enum, IEventStore method,
> ARCH §7 route, and proposal-index drift — but every CRITICAL/HIGH
> finding the run surfaced sat in a class the gate does not yet
> inspect. Three classes account for the bulk:
>
> - **HandlerContext block drift.** Commit `dcdd7d1` added
>   `ctx.withScope` + `ScopeOverrides` to
>   `packages/core/src/handler/types.ts:182-216` and updated
>   `docs/handler-contract.md`, but `docs/ARCHITECTURE.md` §5's
>   HandlerContext interface block was untouched (audit finding H1).
>   ARCH §5 is the authoritative summary readers consult before the
>   handler-contract deep-dive — invisible drift is worse than absent
>   docs.
> - **Proposal-status-vs-code drift.** `recoverable-budget-pause.md`
>   shipped in commit `a2d3a6e` (unified `paused` status,
>   reason-discriminated `fact.run_paused`, `intent.budget_adjusted`,
>   `routing.budget_override.<scope>.<metric>`) but the proposal's
>   front-matter remained `status: proposed, maturity: designed` for
>   34 days, and the opening paragraph still asserted the *pre-ship*
>   behaviour (`fact.run_halted{reason:"budget"}`) as if it were
>   current — actively misleading anyone reading proposals to learn
>   the budget surface (audit finding C3).
> - **JSDoc retry-status drift.** `swarm-events.ts:35-37` JSDoc
>   enumerates auto-retry HTTP statuses as "408/429/5xx/network"; code
>   in `provider-retry-policy.ts:48` includes `529` ("overloaded"),
>   and ARCH §1.10 / `README.md` / `swarm-run` skill all list 529.
>   JSDoc on a public type is a contract surface; readers grep for
>   the JSDoc enumeration to check coverage (audit finding H2).
>
> All three classes are structural — a parser can decide drift
> mechanically — and all three sat undetected for weeks despite the
> existing gate being green on every commit.

## Shape

Three new audits added to the existing `bun run lint:docs` target. Same shape as the audits in [`drift-lint.md`](./drift-lint.md): each is a function in `packages/store/test/lint-docs.test.ts` (or wherever the gate's home becomes if relocated), each prints a unified diff between discovered code surface and documented surface, each honours the existing `// drift-lint: ignore` suppression convention.

1. **`auditHandlerContextBlock`.** Parse the `HandlerContext` interface declaration from `packages/core/src/handler/types.ts` (the `readonly`-prefixed property list plus the JSDoc-bearing methods like `withScope`). For each property name, assert the same name appears inside the fenced TypeScript block under `## 5. Handler contract` in `docs/ARCHITECTURE.md`. Symmetric: assert nothing in the doc block has been deleted from the source. Also extends to the companion `ScopeOverrides` interface (added alongside `withScope` and equally invisible today). Ignores comments and intentional reordering.

2. **`auditProposalStatusVsCode`.** For each `docs/proposals/*.md` whose front-matter `status: shipped`, the audit already (per drift-lint.md item 5) asserts the README claims its capability. *Add the inverse direction*: for each `status: proposed | accepted` proposal, scan the proposal body for a "shipped marker" — common phrasings (`Shipped (commit `, `landed as `, `live since `, `now emits `, `now ships `) coupled with an in-tree commit reference or symbol grep that resolves to current `main`. If the body claims something landed but front-matter is not `shipped`, fail. The lint is conservative — false positives are tolerable because the fix is one front-matter edit; false negatives are the failure mode that drove the audit to write this proposal in the first place. Suppression: `<!-- drift-lint: ignore-status -->` on its own line near the front-matter.

3. **`auditRetryStatusJsDoc`.** Hardcoded mapping for the small set of contract-surface JSDoc enumerations that drift in practice. v1 ships one entry: `swarm-events.ts:PauseReason.provider_error` JSDoc must enumerate exactly the HTTP statuses listed in `packages/daemon/src/provider-retry-policy.ts`'s `AUTO_RETRY_STATUSES` constant (or whichever symbol holds the canonical list — resolve via grep). Generalise to other JSDoc-vs-source enum pairs as drift surfaces. Each pair declared in the lint as `{ docFile, jsdocSelector, sourceFile, sourceSelector }` so additions are one-table-row patches, not one-rule patches.

Each audit fails the gate independently; failures print the discovered set vs the documented set as a unified diff for fast triage.

## Why this is load-bearing

Every CRITICAL and HIGH finding from the 2026-05-04 introspect run (C1, C2, C3, C4, H1, H2, H4, H5) is a drift class the existing lint does not catch. Adding these three audits converts five of those eight from recurring audit findings into pre-merge errors:

| Audit finding | Class | Caught by extension? |
|---|---|---|
| C1, C2 | TypeScript code examples in markdown that don't typecheck | No — out of scope (see [open questions](#open-questions)) |
| C3 | Proposal front-matter says `proposed`, code shipped | Yes — `auditProposalStatusVsCode` |
| C4 | ARCH §3 narrative names a renamed `ctx` field | Partial — caught by `auditHandlerContextBlock` if §3 narrative names the same field as §5's interface block; otherwise out of scope |
| H1 | ARCH §5 HandlerContext block missing `withScope` | Yes — `auditHandlerContextBlock` |
| H2 | JSDoc retry-status drift | Yes — `auditRetryStatusJsDoc` |
| H4 | ARCH §7 missing `GET /runs/:id/messages` route | Already caught by existing `auditDocumentedRoutes` per drift-lint.md item 5 (this finding slipped because the audit checks doc→code, not code→doc); v1 of this proposal does not change that direction. See [open questions](#open-questions). |
| H5 | ARCH section TOC numbering gap | Out of scope — pure prose drift |

The three audits cover the highest-leverage classes per finding-count. The remaining classes (compile-broken markdown examples, narrative drift, TOC integrity) are deferred — the prose-vs-code distance is too high for structural lint to win cheaply.

## Open questions

- **TypeScript-in-markdown typecheck.** C1/C2 (compile-broken `messages.append({ role, content })` example) are real, but the cost of running `tsc` over fenced ` ```typescript ` blocks in `docs/handler-contract.md` is non-trivial and the false-positive rate from import-context inference is high. Defer to a separate proposal once the three audits in this doc soak.
- **Audit direction for ARCH §7 routes.** `auditDocumentedRoutes` (drift-lint.md item) asserts every doc-listed `(method, path)` is a real route — catches stale doc examples. The reverse (every code route appears in §7) is what would have caught H4 — `GET /runs/:id/messages` exists in `runs-routes.ts` but not §7. Adding the reverse direction touches no new packages but risks noise from routes intentionally undocumented (health probes, admin). Resolve before shipping: ship the reverse direction with `// drift-lint: ignore-route` suppression, or open a follow-up.
- **Stylesheet for retry-status JSDoc selector.** `jsdocSelector: "PauseReason.provider_error"` is a string the lint resolves via TS-AST. Sketchy if the type is renamed; hard-fails the lint, which is the desired behaviour but worth a comment in the lint's failure message.

## What this does not commit to

- **Catching semantic drift.** A property that gets renamed and re-introduced with the same name but different meaning will not trip the audit. Out of scope for structural lint.
- **Auto-flipping proposal status.** `auditProposalStatusVsCode` reports; humans flip front-matter. Auto-generated proposal frontmatter is worse than stale frontmatter because it hides intent.
- **Replacing the periodic introspect run.** The narrative review remains the place for qualitative findings, scope arguments, and the "is this rated higher this cycle?" calibration. Lint catches structural drift early and cheaply; introspect catches the rest.
- **Catching the §12-numbering bug (H5).** Renumbered headings in a single doc with cross-references in 8 places — too cheap to write a lint for, too expensive to maintain. Caught by `git grep` during the introspect cycle that surfaced it.

## Implementation notes

Sketch — refine during the change PR. Land as three new test-bound audits in `packages/store/test/lint-docs.test.ts` (or wherever the existing gate's home is at landing time). Each audit:

- Parses one source surface (TS interface block, proposal front-matter, JSDoc).
- Parses one doc surface (ARCH §5 fenced block, README "delivered today" list, ARCH §3 narrative).
- Reports a unified diff between the two when divergent.
- Honours the existing `// drift-lint: ignore` line-prefix convention.

Add a fixture pair (`fixtures/handler-context-drifted/`, `fixtures/handler-context-clean/`) per audit, mirroring the `fixtures/drift-lint/` pattern that drift-lint.md item 5 ships.

Wire into `bun run ci` after the existing `lint:docs` target — same gate, additional audits.

Estimated scope: 2-3 days. Lower bound assumes the lint-docs.test.ts harness already has TS-AST plumbing from the existing `auditIEventStoreInterface`. Higher bound covers the proposal-status audit's heuristic tuning (false-positive shake-out across the existing 30 proposals).
