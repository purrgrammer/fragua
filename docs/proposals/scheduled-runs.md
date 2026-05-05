---
title: Scheduled runs
status: shipped
maturity: shipped
last-reviewed: 2026-05-12
---

# Scheduled runs

Operator-side primitive that fires a workflow on a recurring shorthand
interval. Each fire enqueues a fresh run; the schedule itself owns no
execution state beyond the next-fire pointer.

The headline workload is idempotent maintenance — `analyze`,
`introspect`, `crowdin-review` — at cadences from 1h to 24h. That
constraint shapes every default below: skip-on-overlap, at-most-one
catch-up, no templating, no cron syntax.

## Goals

- A schedule is `(workflow_ref, cwd, interval, optional input)`. No
  cron expressions, no templated input.
- Persistent across daemon restarts. Lives in the store, not session
  memory.
- Each fire creates a normal run with the same shape as
  `swarm run` — no separate execution path. Lineage carried by a new
  `runs.schedule_id` column.
- Skip-on-overlap as the default: maintenance workloads never want
  two concurrent fires of themselves.
- One coalesced catch-up after dispatcher downtime; no thundering
  herd, no replay of every missed slot.

## Non-goals

- **Cron expressions.** Shorthand only (`30m`, `1h`, `6h`, `24h`).
  `interval_ms` column is forward-compatible if cron is added later.
- **Templated input** (`$NOW`, `$ITERATION`, `$LAST_RUN_ID`). Single
  immutable text input or nothing.
- **One-shot reminders** ("fire X at 3pm"). Out of scope; recurrence
  is the only mode.
- **`fire-all-missed` catch-up.** No use case in the stated workload;
  `overlap_policy=queue` covers anyone who wants drip semantics for a
  different workload.
- **Per-schedule LLM/tool budget overrides.** Schedules don't carry
  routing config; budgets cascade through project config like every
  other run.
- **Naming overlap with intra-workflow loops.** `loop` already means
  "backward conditional edge with `max_retries`" in DOT; this
  primitive is `schedule` everywhere — table, CLI verb, event prefix.

## Surface

### CLI

```sh
swarm schedule add <workflow> --every <interval>
                              [--cwd <dir>]
                              [--input "…"]
                              [--on-overlap skip|queue|concurrent]
                              [--no-fire-on-create]
swarm schedule list [--cwd <dir>]
swarm schedule rm <id>
swarm schedule pause <id>
swarm schedule resume <id>
```

`--cwd` defaults to the invocation cwd, matching `swarm run`.
`--on-overlap` defaults to `skip`. First fire happens immediately on
create; pass `--no-fire-on-create` to wait one full interval instead.
`<workflow>` resolves the same way as `swarm run` — bare names against
`~/.swarm/workflows/` then `<cwd>/.swarm/workflows/`.

### HTTP

```
POST   /schedules                       { workflow, cwd, every, input?, overlap?, fireOnCreate? }
GET    /schedules?cwd=…
DELETE /schedules/:id
POST   /schedules/:id/pause
POST   /schedules/:id/resume
```

Each maps 1:1 to one `intent.schedule_*` event written by the web/CLI.
Mirrors the run-intent shape in `runs-routes.ts` so the operator
surface stays one mental model.

### List output

`swarm schedule list` shows a 10-fire health stripe per row so
persistent failure is visible without drilling into runs:

```
ID       Workflow         cwd                Every  Last fire        Next fire        Last 10
sch_a3   analyze          ~/swarm            1h     45m ago (ok)     in 14m           ✅✅✅✅✅✅✅✅✅❌
sch_b9   introspect       ~/swarm            6h     2h ago (ok)      in 4h            ✅✅✅✅✅
sch_c1   crowdin-review   ~/work/translate   24h    18h ago (failed) in 6h            ✅❌✅
```

## Schema additions

```sql
CREATE TABLE schedules (
  id              TEXT PRIMARY KEY,
  workflow_ref    TEXT NOT NULL,                  -- name or path; resolved at fire time
  cwd             TEXT NOT NULL,
  interval_ms     INTEGER NOT NULL,
  interval_text   TEXT NOT NULL,                  -- "1h" — display only
  input           TEXT,
  overlap_policy  TEXT NOT NULL DEFAULT 'skip'
                  CHECK (overlap_policy IN ('skip','queue','concurrent')),
  next_fire_at    INTEGER NOT NULL,               -- unix ms
  last_fire_at    INTEGER,
  last_run_id     TEXT REFERENCES runs(id),
  paused_at       INTEGER,
  created_at      INTEGER NOT NULL
) STRICT;

CREATE INDEX schedules_due
  ON schedules(next_fire_at)
  WHERE paused_at IS NULL;

ALTER TABLE runs       ADD COLUMN schedule_id TEXT REFERENCES schedules(id);
ALTER TABLE run_state  ADD COLUMN schedule_id TEXT;
CREATE INDEX runs_by_schedule ON runs(schedule_id) WHERE schedule_id IS NOT NULL;
```

`workflow_ref` is stored as a string, not a sha or upload reference —
schedules survive workflow edits, and resolution happens at fire time.
If the file is missing or fails to validate, the schedule auto-pauses
(see Failure handling).

## Event taxonomy additions

| Event | Writer | Payload |
|---|---|---|
| `intent.schedule_create` | web / CLI | full descriptor |
| `intent.schedule_pause` | web / CLI | `{ schedule_id }` |
| `intent.schedule_resume` | web / CLI | `{ schedule_id }` |
| `intent.schedule_delete` | web / CLI | `{ schedule_id }` |
| `fact.schedule_fired` | daemon | `{ schedule_id, run_id }` |
| `fact.schedule_skipped` | daemon | `{ schedule_id, reason: "overlap" \| "paused" }` |
| `fact.schedule_late` | daemon | `{ schedule_id, missed_intervals, last_target_at }` — emitted *before* the catch-up fire when ≥1 slot was missed |
| `fact.schedule_invalid_workflow` | daemon | `{ schedule_id, error }` — auto-pause path |

Per AGENTS.md ground rule #1 these events propagate to ARCH §3 in the
landing PR.

## Daemon dispatcher

A new `schedule-dispatcher` fiber under `packages/daemon/src/`,
peer to `auto-dispatcher` and `wake-pending`. Wakes once a minute (or
on `intent.schedule_*` notification). On each tick:

```
SELECT id FROM schedules
WHERE paused_at IS NULL AND next_fire_at <= ?  -- now
ORDER BY next_fire_at ASC

for each due schedule:
  if overlap_policy = 'skip' and last_run_id is non-terminal:
    emit fact.schedule_skipped { reason: "overlap" }
    advance next_fire_at = now + interval_ms
    continue

  resolve workflow_ref against ~/.swarm/workflows/, then cwd
  if missing or validator E0xx:
    emit fact.schedule_invalid_workflow { error }
    set paused_at = now
    continue

  if missed_intervals >= 1:
    emit fact.schedule_late { missed_intervals, last_target_at }

  emit intent.run_create with schedule_id
  emit fact.schedule_fired { run_id }
  set last_fire_at = now
      last_run_id = <new run id>
      next_fire_at = now + interval_ms
```

Anchor forward from actual fire time, not from the original target.
A 1h schedule that fires at 12:03 next fires at 13:03, not 13:00.
Avoids drift compounding into thundering herds across schedules whose
targets happen to align.

## Catch-up policy

**At-most-one fire per resume window.** When the dispatcher wakes
after downtime and finds N missed slots, it fires once, emits
`fact.schedule_late { missed_intervals: N }` for visibility, and
resumes cadence anchored from the actual fire time.

| Situation | Policy |
|---|---|
| Daemon down 4h on a 1h schedule | 1 fire on resume, next in 1h |
| Daemon down 3 days on a 1h schedule | 1 fire on resume, next in 1h (not 72) |
| Catch-up due, prior run still active, `overlap=skip` | Skip the catch-up entirely; advance `next_fire_at` |
| `intent.schedule_resume` after explicit pause | **No** catch-up. `next_fire_at = now + interval_ms`. Pause is a declared "no fires during this window" — resume must not retroactively contradict it |
| `intent.schedule_create` | Fire immediately by default. `--no-fire-on-create` waits one full interval |
| Wall clock jumps backward (NTP, suspend) | `next_fire_at - now` becomes large positive → schedule appears not-due → waits naturally. No special handling |

Justification for at-most-one: `analyze`/`introspect`/`crowdin-review`
running 5× back-to-back gives nothing over running them 1×. The
operator who wants drip semantics — every missed slot replayed —
should set `overlap_policy=queue`, which already covers that case
through the run-creation path rather than the catch-up path.

## Failure handling

Schedules keep firing across run failure. Maintenance workflows are
idempotent; one bad fire is not a reason to disable the cadence. The
10-fire health stripe in `schedule list` makes persistent failure
visible enough that the operator can pause manually.

One escape hatch: if the workflow reference can't be **parsed or
validated** at fire time (file deleted, validator emits an `E0xx`
error), the schedule auto-pauses with `fact.schedule_invalid_workflow`.
A broken workflow won't recover by being fired more, and emitting
broken runs every interval is pure noise. Fixing the file and
`schedule resume` brings it back.

Transient run-time failures — provider errors, budget pauses, halted
runs — do not pause the schedule. They show up in the stripe.

## Lifecycle

- **Create** → row inserted, `next_fire_at = now` (or `now + interval`
  with `--no-fire-on-create`).
- **Pause** → `paused_at = now`, dispatcher ignores the row, in-flight
  runs continue uninterrupted.
- **Resume** → `paused_at = NULL`, `next_fire_at = now + interval_ms`.
  No catch-up.
- **Delete** → hard `DELETE FROM schedules WHERE id = ?`. Past runs
  retain their `schedule_id` for lineage even though the schedule row
  is gone — `runs.schedule_id` is informational, not a FK we cascade.

No 7-day expiry (Claude Code's `/loop` has one because session-scoped
tasks have a different blast radius; here the operator deletes
explicitly).

## Open questions

- **Run lineage in `run_state`.** Worth carrying `schedule_id` on
  `run_state` (cheap, projection-side) or only on `runs` (canonical)?
  The dashboard wants to filter "runs from schedule X" without
  joining; projection-side seems right but that's a §3-projection
  decision, not a primitive decision.
- **Validator-driven auto-pause threshold.** Currently "any E0xx
  pauses." If the validator gains warnings that look like errors,
  this widens unintentionally. Worth a fence — only the parser-error
  / file-missing classes should pause; semantic warnings should fire
  anyway.

## Doc obligations on landing

Per AGENTS.md ground rule #1:

- `ARCHITECTURE.md` §2 — schema (new `schedules` table, `runs.schedule_id`)
- `ARCHITECTURE.md` §3 — event taxonomy (`intent.schedule_*`, `fact.schedule_*`)
- `ARCHITECTURE.md` §7 — operator routes (5 new endpoints)
- `packages/types/src/swarm-events.ts` — event declaration merges
- `packages/store/src/schema.sql` — schema bump
- `README.md` "What swarm delivers today" — add the schedule primitive
- `.agents/skills/swarm-run/SKILL.md` — operator cheat sheet for
  schedule create/list/pause/rm
