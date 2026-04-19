# Lifecycle × interrupt matrix

> **Superseded by `REARCHITECTURE.md`.** This document describes the pre-Revision-2 file-based coordination surface (events.jsonl + checkpoint.json + control.jsonl + fs.watch + in-daemon JobQueue). It is kept for historical context only. Trust [REARCHITECTURE.md](./REARCHITECTURE.md) when the two disagree.


Coverage of pipeline/job lifecycle states crossed with interrupts. Each cell
links to the test that pins down the expected terminal state.

## States

- **running** — executor processing nodes
- **paused** — gated at a node boundary via `control.pause`
- **wait.human** — blocked inside `Interviewer.ask` on a hexagon gate
- **retrying** — mid-retry attempt (handled by `runWithRetry`)
- **orphaned** — worker process exited with no terminal event written

## Interrupts

- **control.cancel** — user requests termination
- **control.pause / control.resume** — soft-pause at next boundary
- **control.steer** — inject message to running agent
- **worker crash** — process exits unexpectedly
- **daemon restart** — server process restarts; orphan recovery runs
- **interview.timeout** — human gate idle timeout elapses

## Matrix

| State \ Interrupt | cancel | pause | resume | steer | worker crash | daemon restart | interview.timeout |
|---|---|---|---|---|---|---|---|
| **running** | `pipeline.canceled` (control-cancel.test.ts) | `pipeline.completed` after resume (control-pause.test.ts) | `control.rejected:not_paused` (control-pause.test.ts) | message buffered/injected (control-idempotency.test.ts) | job `failed` w/ "daemon restart" (orphan-recovery.test.ts) | resume from checkpoint (checkpoint-resume.test.ts) | n/a |
| **paused** | `pipeline.canceled` (control-cancel.test.ts) | idempotent `already_paused` (control-pause.test.ts) | unblocks; `pipeline.completed` (control-pause.test.ts) | message applied while paused (pause-steer-resume-cancel.test.ts) | same as running | resume respects paused flag (checkpoint-resume.test.ts) | n/a |
| **wait.human** | `pipeline.canceled` via signal race (cancel-at-wait-human.test.ts) | pauses at boundary after ask completes (implicit; soft pause) | n/a | message buffered for after gate resolves | same as running | wait.human restarts on resume (wait-human.test.ts) | `pipeline.failed` w/ "human gate timed out" (wait-human.test.ts); cancel takes precedence if racing (cancel-vs-interview-timeout.test.ts) |
| **retrying** | cancel unwinds mid-retry (control-cancel.test.ts) | gates at next boundary | n/a | buffered | same as running | retry counter resumed from checkpoint (checkpoint-resume.test.ts) | n/a |
| **orphaned** | gateway append is silent no-op (see notes) | n/a | n/a | silent no-op | n/a | reconciled via `events.jsonl` terminal event or `failed` (orphan-recovery.test.ts) | n/a |

## Cross-cutting invariants

- **Control idempotency across restarts** — `last_applied_control_id` in the checkpoint is advanced on every apply and a final checkpoint is persisted after control-loop teardown so fast-completing runs don't lose the marker. Tested across two restarts in `control-idempotency.test.ts` ("dedup marker survives two restarts").
- **Torn writes to `control.jsonl`** — the tail reader buffers partial lines until a newline arrives and silently drops any JSON line that fails parse or lacks required fields (`parseControlLine`). Tested in `packages/events/test/control.test.ts`.
- **Cancel beats timeout** — `waitHumanHandler` races the interviewer promise against `ctx.signal`. A cancel arriving during the timeout window produces `pipeline.canceled`, not a spurious `pipeline.failed`-via-timeout.
- **Every `control.requested` has a matching `control.applied` or `control.rejected`** — including the tricky case where resume/cancel arrives before a pending pause has had a chance to land at a node boundary (emitted with `note: "superseded_by_resume"` / `"superseded_by_cancel"`). Fuzzed in `control-fuzz.property.test.ts`.
- **Job queue state machine** — claimed rows are never re-claimed, terminal status is one-shot, `count(status)` always equals `list({status}).length`. Fuzzed in `sqlite-job-queue.property.test.ts` across 80 random op sequences.
- **Checkpoint concurrent save safety** — parallel `save()` calls land exactly one valid checkpoint; no torn file and no ENOENT on rename (unique per-write tmp suffix). Fuzzed in `checkpoint.property.test.ts`.
- **Orphan recovery never touches queued rows** — recovery running concurrently with enqueue/claim only reconciles `running` rows. Tested in `scheduler-orphan-race.test.ts`.

## Known gaps

- **Late cancel on a terminated run via the server** — `POST /pipelines/:runId/cancel` appends to `control.jsonl` even when the executor is gone. The client gets 202. Semantically harmless (no one reads the line) but a minor UX wart: the server could check whether the run has a terminal event and return 409 instead. Low priority.
- **`control.applied` for steer while paused** — currently fires synchronously via the control loop (not gated on the pause boundary). Behavioural test exists (`pause-steer-resume-cancel.test.ts`); the design choice is that steer is a nudge and should be delivered immediately even while the run is gated, since the backend buffers it for the next turn anyway.
