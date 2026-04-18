# Daemon and dev server

`swarm run` is a fire-and-forget client: it POSTs to the daemon's `/jobs` endpoint and exits. The daemon owns workflow execution, writes `events.jsonl`, exposes HTTP + SSE, and supervises concurrent runs. One daemon per repo.

```sh
bun run packages/cli/bin/swarm.ts daemon start          # detaches, rendezvous at .swarm/daemon/
bun run packages/cli/bin/swarm.ts daemon status         # JSON: pid + port + queue counters
bun run packages/cli/bin/swarm.ts daemon logs -f        # tail .swarm/daemon/daemon.log
bun run packages/cli/bin/swarm.ts daemon stop           # SIGTERM + grace → SIGKILL
bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot --input "…"
# → queued: <jobId>
#     run:  <runId>
#     view: http://127.0.0.1:3737/pipelines/<runId>
```

`swarm run` auto-starts a daemon if none is running; pass `--no-autostart` to fail fast (useful for CI). Workflows run in an isolated git worktree (`swarm/<runId>`) by default — pass `--no-worktree` to opt out.

## `.swarm/daemon/` layout

- `daemon.json` — rendezvous `{ pid, port, startedAt, version }`, atomic write.
- `queue.db` — SQLite job queue (WAL mode, `UPDATE…RETURNING` for `claimNext`).
- `daemon.log` — stdout/stderr of the daemon, size-capped rotation on start (→ `daemon.log.1` at 10MB).

## REST surface

On top of the existing `/pipelines/*` + `/workflows` + `/stats` + control routes:

- `POST /jobs { workflow, input?, model?, worktree?, runId? }` → 202 `{ jobId, runId }`.
- `GET /jobs[?status=…&limit=N]` → `JobRow[]`.
- `GET /jobs/:id` → one row, 404 on miss.
- `DELETE /jobs/:id` — queued rows are removed (200); running rows get their cancel forwarded through the existing `ControlGateway` (202 + `{ requestId }`); terminal rows return 409.
- `GET /health` carries a `daemon: {...}` snapshot (pid, port, startedAt, version, concurrency, inflight, queued). Absent when a plain `swarm serve` is running — the web UI's banner reads this to distinguish live vs. read-only.

Other routes: `GET /pipelines`, `GET /pipelines/:id`, `GET /pipelines/:id/steps` (`StepSnapshot[]` reconstructed from `llm.start` + companion events), `GET /stats` (aggregate tiles), `GET /runs/:id/events` (SSE), plus the interview and workflows routes. Shapes live in `packages/server/src/schemas.ts`.

## Orphan recovery

On start the daemon scans every `status='running'` row in the queue: alive child pids are adopted via a small watcher; dead children reconcile against the last terminal event in `events.jsonl` (`pipeline.completed` → success, canceled, otherwise failed with a "daemon restart" note).

## `swarm serve` (read-only dev)

Starts the HTTP server in the foreground with no queue wired up (so `/jobs` returns 503). Prefer `swarm daemon start` for anything but one-off debugging.

```sh
bun run packages/cli/bin/swarm.ts serve --port 3000     # foreground, no queue
curl http://localhost:3000/health   # {"ok":true}  ← note: no `daemon` key
```

## Flags

`--port <n>` (default 3000 for `serve`, 3737 for the daemon; `0` picks an ephemeral port), `--runs-dir <path>`, `--cwd <path>`. No auth / HTTPS — the daemon binds `127.0.0.1` only; put a reverse proxy in front for anything else.

## Read-side abstractions

`@swarm/events` exposes the inverse of `EventSink`:

- `EventSource` — `listRuns() + readRun(runId)`; the port that JSONL / Postgres / OTel adapters implement.
- `Projection<T>` — pure reducer `Event[] → T`. `stepsProjection` and `summaryProjection` are the first consumers.
- `projectRun(source, runId, projection)` — sugar for "load run → handle 404 → project". `foldAll(source, projection, folder, init)` is the aggregate path (e.g. `/stats`).
- `MaterializedProjectionStore<T>` — optional interface a DB adapter implements when it wants to precompute + cache projections.
- `migrateAllRuns(source, sink)` — supported path for moving an archive between backing stores (JSONL → Postgres). Idempotency is the sink's job.
- `CheckpointStore` port (`@swarm/core`) + `JsonlCheckpointStore` adapter — `save(runId, checkpoint)` / `load(runId)`. Enables resume via `execute({ checkpointStore, resume: true })`. See `docs/SPEC.md §3.6` for the resume-degradation rule. The CLI wires this via `swarm run --resume --run-id <original-id>`; checkpoints are written by default (disable with `--no-checkpoint`).
