# Run control: steer, pause, resume, cancel

> **Superseded by `REARCHITECTURE.md`.** This document describes the pre-Revision-2 file-based coordination surface (events.jsonl + checkpoint.json + control.jsonl + fs.watch + in-daemon JobQueue). It is kept for historical context only. Trust [REARCHITECTURE.md](./REARCHITECTURE.md) when the two disagree.


Every running pipeline exposes a sibling control file at `.swarm/runs/<run-id>/control.jsonl`. CLI commands write `ControlRequest` lines there; the executor's control loop tails the file (via `fs.watch`, no polling), mirrors each request into `events.jsonl` as `control.requested`, and dispatches to the right safe boundary before emitting the paired `control.applied` or `control.rejected`. All four commands share this one channel — nothing special-cases by command at the transport layer.

```sh
bun run packages/cli/bin/swarm.ts steer  <run-id> "focus on the failing test"
bun run packages/cli/bin/swarm.ts pause  <run-id>
bun run packages/cli/bin/swarm.ts resume <run-id>
bun run packages/cli/bin/swarm.ts cancel <run-id> --reason "wrong branch"
```

**Steer** injects a user message into the running agent at its next turn boundary (same UX as before; web UI renders it as a user chat bubble inside the active node's turn).

**Pause** is soft: the currently-running node completes first. The gap between `control.requested(pause)` and `control.applied(pause)` is the implicit "pending" state — `applied_at_node` on the applied event tells you which node ran last. A second pause while already paused is idempotent (emits `control.applied` with `note: "already_paused"`).

**Resume** wakes the paused scheduler. Rejected with `reason: "not_paused"` if the run isn't paused.

**Cancel** trips the executor's AbortController, lets in-flight work unwind via its signal, and emits `pipeline.canceled` as the terminal event (instead of `pipeline.failed` / `pipeline.completed`). The run's exit status is non-zero but consumers should distinguish canceled from spontaneous failure via the terminal event, not the exit code.

## Restart-safety

Each request carries a uuid `id`; the executor records `last_applied_control_id` on the checkpoint. On `--resume`, the control loop re-tails `control.jsonl` from the top but skips every request up to and including that marker — no double-application.

## Legacy

Older runs that wrote `steering.jsonl` and emitted `steering.injected` still replay correctly; the web conversation reducer keeps those branches. New runs always go through the control channel.
