---
title: Operator-surface contract tests
status: proposed
maturity: specified
last-reviewed: 2026-05-01
---

# Operator-surface contract tests

> Catch C6-class drift where the `swarm-run` skill teaches a curl body
> shape that the server validates as 4xx — e.g. the `/hitl` endpoint
> was being taught as `{input}` while the server requires `{selected}`.
> Boot a daemon, enqueue a one-node workflow, and exercise every
> documented operator endpoint against the body shapes the skill
> teaches. Failure modes the test must catch: 4xx returned for a
> documented body, an endpoint disappearing, response-shape drift.
>
> Pairs with [drift-lint](./drift-lint.md): drift-lint catches
> *structural* drift (schema columns, event-type names, enum values)
> by parsing source and comparing against doc text. This catches
> *behavioural* drift the lint can't see — a body shape can typecheck
> against a TypeBox schema and still be the wrong shape.

## Shape

A new test target — `bun test packages/server/test/operator-surface.test.ts`
or similar — that:

1. Boots a daemon (in-memory or spawned; see open questions) against
   a temp DB.
2. Uploads a trivial one-node workflow and enqueues a run.
3. For each documented operator endpoint
   (`POST /runs/:id/{steer, pause, cancel, hitl, resume,
   unquarantine, priority}`), issues a request whose body matches
   the shape the `swarm-run` skill teaches.
4. Asserts:
   - `2xx` on every documented body.
   - Response shape matches what the skill claims it returns.
   - All seven endpoints exist (no 404).

Routes live in `packages/server/src/store/runs-routes.ts`; skill
fixtures live in `.agents/skills/swarm-run/SKILL.md`.

## Why now

The C6 audit finding was a `swarm-run` skill example teaching a body
the server rejects. Nothing in the suite caught it because:

- The server's TypeBox validator passes for any well-typed body.
- The skill's example is prose, invisible to the typechecker.
- No integration test issues the exact bodies the skill prints.

The gap is small and the failure mode is loud once it lands in a
user's terminal. A handful of fixtures closes it.

## Open questions

- **In-memory vs real daemon.** A spawned `bun run swarm daemon` is
  the most honest test (catches port-binding, lock-file, and IPC
  bugs) but is slow and flaky in CI. An in-process daemon harness is
  faster but trusts that the spawn path matches. Lean toward
  in-process for speed, with one smoke test that spawns the real
  binary.
- **Scrape vs fixture.** Either regex-extract the curl bodies from
  `.agents/skills/swarm-run/SKILL.md` (lossy, brittle to skill
  prose changes) or maintain a fixture file the skill cites
  (single source of truth, but the skill must reference it
  explicitly). Fixture is the cleaner contract.
- **Stability under skill evolution.** When the skill legitimately
  adds a new endpoint or changes a body, the test must update in
  the same PR. Snapshot review or a versioned fixture both work;
  the AGENTS.md rule #1 same-PR contract for `<contract file>`
  changes is the closest existing precedent.

## What this does not commit to

- Load testing. This is shape conformance, not performance.
- Validating skill *prose* — only the bodies. Whether the skill
  explains them well is a human review concern.
- Read-side endpoints (`GET /runs`, `/events`, `/messages`,
  `/steps`). Drift there is caught by the web client and by
  drift-lint's response-schema checks; this proposal is scoped to
  the seven write-side operator endpoints.
- Replacing drift-lint. The two complement: structural lint runs in
  ~50ms with no daemon; this runs slower and exercises live
  request/response.
