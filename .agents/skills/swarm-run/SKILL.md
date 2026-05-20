---
name: swarm-run
description: Drive a swarm run from enqueue to terminal state. Load this when the user says "run workflow X", "kick off change", "enqueue ci-gate", "start a run against …", "steer this run", "pause/cancel/resume run …", "send HITL input", "unquarantine <run>", "bump priority on …", or otherwise asks to operate on live runs (not analyse completed ones — that's swarm-debug). Teaches pre-flight (harness liveness + provider credentials), the two equivalent entry points (`swarm run` CLI vs. `POST /workflows` + `POST /runs`), how to watch a run over SSE / events.json / /steps, the intent vocabulary (steer, pause, cancel, hitl, unquarantine, priority) with post-conditions for each, and the HITL resume + quarantine-resolution protocols. Assumes Claude Code with Bash / Read / curl on a swarm checkout.
---

# swarm-run — enqueue, watch, and control a live run

The goal is to go from a workflow (a name resolvable under `~/.swarm/workflows/` or `<cwd>/.swarm/workflows/`, or a literal `.dot` path) to a running, observable run that you can steer safely. Prefer the CLI for interactive runs; reach for the HTTP surface when you need priority / routing / no-follow / scripting.

Authoritative references: `docs/SPEC.md` §3 (primitives + control plane), `docs/ARCHITECTURE.md` §3 (event taxonomy) + §7 (web server), `AGENTS.md` (commands).

---

## Fast path

```sh
# Pre-flight — both must be true.
sqlite3 -readonly ~/.swarm/swarm.db \
  "SELECT pid, http_url, (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS age_s
     FROM daemon_lock;"      # row present + http_url non-null + age < 30s
bun run swarm providers ls   # at least one provider shows ✓

# Run. Trailing args become $ARGUMENTS; --input name=value (repeatable)
# binds typed inputs declared in the workflow's `inputs:` block.
bun run swarm run change "rename foo() to bar() in packages/core"
bun run swarm run deploy --input ticket=BUG-1 --input env=prod
```

The CLI does three things: `POST /workflows` (uploads source, returns sha), `POST /runs` (enqueue), `GET /runs/:id/stream` (SSE tail until terminal). Terminal facts: `fact.run_completed | fact.run_halted | fact.run_cancelled | fact.run_paused_human | fact.run_paused | fact.run_quarantined`. CLI exits non-zero on halt/cancel; `paused_*` is suspensive (CLI exits 0; the run resumes on its own via retry timer or operator HITL response).

If the fast path works, nothing else here matters.

---

## 1. Pre-flight

The harness owns the daemon + HTTP server in one foreground process. Discovery rides on `daemon_lock` in the DB — no JSON files in the default install.

```sh
# Default DB (harness layout)
sqlite3 -readonly ~/.swarm/swarm.db <<'SQL'
.mode column
SELECT pid, hostname, http_url, http_port,
       datetime(heartbeat_at/1000,'unixepoch','localtime') AS last_beat,
       (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS seconds_ago
FROM daemon_lock;
SQL

# `http_url` populated → harness running. Hit /health to confirm.
URL=$(sqlite3 -readonly ~/.swarm/swarm.db "SELECT http_url FROM daemon_lock;")
[ -n "$URL" ] && curl -fsS --max-time 2 "$URL/health" | jq .

# Provider credential
bun run swarm providers ls
```

Common failures:

- **No `daemon_lock` row** — no daemon running. Start: `bun run swarm harness` (default) or `bun run swarm daemon start --db <path>` (CI primitive).
- **Heartbeat > 30s old** — daemon dead. Runs stay `queued` until a new one claims the lock. Restart the harness.
- **`http_url` NULL** — the daemon is up but the harness hasn't published the HTTP URL. Either the harness is mid-startup, or the user is on the CI-primitive path (`swarm daemon` + `swarm serve` separately) — in that case, fall back to `<cwd>/.swarm/serve.json` for discovery.
- **Provider not credentialed** — `POST /runs` 400s with `code="provider_unavailable"`. Fix: `swarm providers add <provider>` or `swarm providers login <provider>`.
- **Model not registered** — `POST /workflows` 400s with `code="model_unresolved"`. Either register the model or switch the workflow's `model=` attr. For a *new* provider use the full wizard (`swarm providers add --custom`); when the provider already exists and you just want one more model, skip the wizard with `swarm providers add-model <provider> <id> [--context-window N --max-tokens N --reasoning --input text,image --cost-input X --cost-output X --yes]`. Both write to `~/.swarm/swarm.db`'s `provider_config` table; the per-model verbs (`ls-models` / `add-model` / `rm-model` / `edit-model`) Ajv-validate on read and write so a typo refuses cleanly instead of poisoning the row.

The user should run `swarm harness` themselves — don't start it on their behalf without asking; the harness attaches to the current shell.

---

## 2. Entry points

Two equivalent surfaces. Use the CLI unless the task requires scripting.

### CLI (`swarm run`)

```sh
bun run swarm run <workflow> [trailing positional args]  \
  [--input name=value]   # typed input; repeat for several (gh-style)
  [--priority 10]        # higher runs first (queue tie-breaker)
  [--no-follow]          # enqueue and exit; print only the run id
  [--url http://…]       # override DB-based discovery
  [--db path/to/db]      # pairs with `swarm serve --db` for parallel swarms
```

`<workflow>` resolves: bare name → `~/.swarm/workflows/<name>.yaml` first, then `<cwd>/.swarm/workflows/<name>.yaml`. Anything containing `/` or ending `.yaml` resolves as a literal path.

Trailing positional args are joined with spaces into `$ARGUMENTS`. `--input name=value` (repeatable) binds the typed inputs declared in the workflow's `inputs:` block, substituted as `${{ inputs.name }}`; a missing required input or an out-of-range `choice` is rejected at enqueue. The run id prints immediately; terminal facts print colorised as they stream.

### HTTP (`POST /workflows`, then `POST /runs`)

The CLI is a thin client over this. Use directly when you need arbitrary `routing`, scripted enqueue, or multiple runs in flight.

```sh
URL=$(sqlite3 -readonly ~/.swarm/swarm.db "SELECT http_url FROM daemon_lock;")

# 1. Upload (idempotent; sha is content-addressed).
SHA=$(curl -fsS -X POST "$URL/workflows" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg n change --rawfile s path/to/workflow.yaml \
        '{name:$n, source:$s}')" | jq -r .sha)

# 2. Enqueue. `input` lands in routing.input → $ARGUMENTS; `inputs` lands
#    in routing.inputs → ${{ inputs.x }} (validated against the inputs: block).
RUN=$(curl -fsS -X POST "$URL/runs" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg sha "$SHA" --arg in "rename foo() to bar()" --arg cwd "$PWD" \
        '{workflowSha:$sha, priority:5, input:$in, inputs:{ticket:"BUG-1"}, cwd:$cwd}')" | jq -r .runId)

# 3. Tail. Last-Event-ID resumes on reconnect.
curl -N "$URL/runs/$RUN/stream" -H 'Accept: text/event-stream'
```

`workflowSha` is sha256 of the workflow source — same source twice → same sha → cheap re-enqueue. `runId` is a ULID when omitted. `cwd` becomes the run's project root (worktree base, project listing key); omit for ephemeral CI runs.

---

## 3. Watch a run

| Surface | Use when |
|---|---|
| `GET /runs/:id/stream` (SSE) | Live progress. Terminates on disconnect. |
| `GET /runs/:id/events.json` | Point-in-time snapshot; scripting; diffing. |
| `GET /runs/:id/steps` | Per-LLM-call snapshots (prompt, model, tokens, cost; rows for parallel branches carry `parentNodeId` + `parallelIndex`). |
| `GET /runs/:id` | Projection summary (runStatus, status, current node, totals). Cheap status poll. |

**Two status fields, don't conflate them.** `GET /runs/:id` returns BOTH `runStatus` (lifecycle: `queued | running | completed | halted | cancelled | paused | paused_human | paused_auto | quarantined`) AND `status` (the run's final *outcome*: `success | fail`, or `null` while not yet terminal). For "is the run still going?" checks use `runStatus`; for "did it succeed?" once terminal use `status`. The cheat sheet and the lifecycle table below use `runStatus` consistently.

```sh
curl -fsS "$URL/runs/$RUN" | jq '{runStatus, status, currentNode, costUsd, totalTokens: ((.inputTokens // 0) + (.outputTokens // 0))}'
curl -fsS "$URL/runs/$RUN/events.json" | jq '.[-20:] | map({seq, type, payload})'
curl -fsS "$URL/runs/$RUN/steps" | jq '.[] | {stepIdx, nodeId, model, durationMs, tokens, costUsd}'

# Polling pattern — watch runStatus, not status.
until curl -fsS "$URL/runs/$RUN" | jq -e '.runStatus | IN("completed","halted","cancelled","paused_human","paused","quarantined")' >/dev/null; do
  sleep 30
done
```

For running-but-silent runs: if the last event is `fact.node_started` with no follow-up after the node's `maxMs`, the supervisor watchdog should have fired — if it hasn't, the daemon is wedged. Jump to swarm-debug.

**`runStatus` lifecycle states beyond `running` / `completed`:**

- `queued` — waiting for a daemon dispatch slot.
- `paused_human` — `human` node yielded. Resume with `POST /runs/:id/human`.
- `paused` — operator-resumable. Reason on `fact.run_paused.payload.reason`: `operator` (operator paused), `provider_error` (manual-class HTTP failure: 400/401/403/404/413/422 — fix creds/request, then `/resume`), `payment_required` (402 — top up at the provider, then `/resume`), `budget` (local cap hit — raise via `POST /runs/:id/budget`, then `/resume`).
- `paused_auto` — daemon owes a clock tick. Reason on `fact.run_paused.payload.reason`: `handler_retry` (node returned `outcome=retry`, engine scheduled a backoff), or `provider_retry` (auto-retryable provider transport error — 408/429/5xx/529/network). The run *frees its concurrency slot* during the wait. Wake-pending re-queues it once `routing.internal.auto_resume_at` (ms epoch) passes; you'll see `fact.run_resumed { fromStatus: "paused_auto" }` followed by the same node re-dispatched. No operator action unless the timer never fires (then check daemon heartbeat); operators can short-circuit with `POST /runs/:id/resume`.
- `quarantined` — orphan side effect. Operator must resolve via `/unquarantine` (§6).
- `halted` / `cancelled` — terminal. swarm-debug §8 has the `reason` codes.

---

## 4. Control plane — the intent vocabulary

Every operator action is an HTTP POST that appends an `intent.*` event. No OCC: intents are **always appendable** (SPEC §3.5). Daemon picks them up on the next supervisor tick (~50ms).

All endpoints return `{ seq }` — quote it in any follow-up so the user can find the action in the event stream.

| POST | Body | Written intent | Post-condition |
|---|---|---|---|
| `/runs/:id/steer` | `{text}` | `intent.steering_requested` | Handler aborts (`cause:"steer"`); next dispatch sees the steering text in the thread. |
| `/runs/:id/pause` | `{}` | `intent.pause_requested` | Handler aborts (`cause:"pause"`); `runStatus` → `paused` (`reason:"operator"`). |
| `/runs/:id/cancel` | `{reason?}` | `intent.cancel_requested` | Handler aborts (`cause:"cancel"`); terminal `fact.run_cancelled`. |
| `/runs/:id/human` | `{route, note?}` | `intent.human_input` | For `kind=human` nodes: routes to the outgoing edge whose `route=` attribute equals the posted `route`. 400 if `route` is not in the node's declared `routes=` enum. |
| `/runs/:id/resume` | `{note?}` | `intent.resume` | Wake-pending sweeper transitions any `paused_*` run back to `queued`. |
| `/runs/:id/unquarantine` | `{resolution, note?}` | `intent.unquarantine` | Resolves the orphan side effect per `resolution` ∈ `treat_as_done | retry | cancel`. |
| `/runs/:id/priority` | `{newPriority, note?}` | `intent.priority_adjusted` | Queue ordering updated. Already-running runs unaffected. |
| `/runs/:id/budget` | `{scope, metric, newLimit, note?}` | `intent.budget_adjusted` | Override stored at `routing.budget_override.<scope>.<metric>`; next turn-boundary check uses the new ceiling. Doesn't wake on its own — pair with `/resume`. |

### Steering

Steering injects text into the next LLM call's prior-messages thread. The current handler aborts (lossless — pi-agent-core keeps what it had) and re-dispatches. Use small, specific nudges. Long essays are usually the wrong tool; prefer `cancel` + a fresh run with better `$ARGUMENTS`.

```sh
curl -fsS -X POST "$URL/runs/$RUN/steer" \
  -H 'content-type: application/json' \
  -d '{"text":"skip the migration step; the schema is already at head"}' | jq .seq
```

Wait for `fact.node_aborted { cause:"steer", intentSeq: <returned seq> }` → `fact.node_started` for the same node (same `nodeId`, `iteration` bumped).

### Pause + resume

Pause is steer-without-text: abort the current handler and flip to `paused` with `reason:"operator"`. Resume with `/resume`. `/human` is for `kind=human` (hexagon) nodes only; sending it to an operator-paused run is the wrong shape.

### Cancel

Final: terminal `fact.run_cancelled`, no resume path. Prefer `pause` + decide later if unsure.

### Human inputs

For human-node (hexagon) gates. `route` must match one of `fact.run_paused_human.payload.routes`. See §5 + workflows §14.

### Priority + budget

`priority` re-orders the queue (running runs unaffected). `budget` raises a cap on a `paused{reason:"budget"}` run; the web UI bundles `/budget` + `/resume` in one click.

---

## 5. Human resume protocol

Runs sit in `paused_human` until you feed them. Read what they want:

```sh
curl -fsS "$URL/runs/$RUN/events.json" \
  | jq '[.[] | select(.type=="fact.run_paused_human")] | last'
# { seq, type, payload: { nodeId, text, routes: ["apply", "output_only", "reject"] }, … }
```

`route` must equal one of the strings in `payload.routes`. The server validates against the declared enum (400 on off-list); the handler re-checks as defense-in-depth.

Present the decision to the user — don't answer on their behalf unless they've explicitly delegated it.

---

## 6. Quarantine resolution

A run lands in `quarantined` when the startup sweep finds `fact.side_effect_intent` without a matching `_done`/`_failed`. The external effect may have succeeded, failed, or never reached the provider — swarm can't tell. Operator decides.

```sh
# The orphans:
curl -fsS "$URL/runs/$RUN/events.json" \
  | jq '[.[] | select(.type=="fact.run_quarantined")] | last | .payload.orphanedIntents'

# Resolutions:
#   treat_as_done — assume effect completed (use when provider idempotency is strong)
#   retry         — replay (use when verified external state matches a re-try)
#   cancel        — stop the run (use when blast radius is unclear)
curl -fsS -X POST "$URL/runs/$RUN/unquarantine" \
  -H 'content-type: application/json' \
  -d '{"resolution":"cancel","note":"verified the external effect via <evidence>"}'
```

Present options + evidence to the user. Never auto-choose.

---

## 6.5 Schedules — recurring runs

A schedule fires a workflow on a fixed shorthand interval (`30m` / `1h` / `6h` / `24h` only — cron is out of scope). Each fire enqueues a normal run with `run_state.schedule_id` carrying lineage. Skip-on-overlap is the default; one coalesced catch-up after daemon downtime.

```sh
# Add
bun run swarm schedule add analyze --every 1h
bun run swarm schedule add introspect --every 6h --on-overlap skip
bun run swarm schedule add change --every 24h --input "sweep deps" --no-fire-on-create

# Inspect
bun run swarm schedule list
bun run swarm schedule list --cwd "$PWD"

# Operate
bun run swarm schedule pause sch_xxxxxx
bun run swarm schedule resume sch_xxxxxx       # no catch-up; next_fire_at = now + interval
bun run swarm schedule rm sch_xxxxxx
```

HTTP equivalents (mirrors the CLI 1:1):

```sh
URL=$(sqlite3 -readonly ~/.swarm/swarm.db "SELECT http_url FROM daemon_lock;")

curl -fsS -X POST   "$URL/schedules"               -H 'content-type: application/json' \
   -d '{"workflow":"analyze","cwd":"'"$PWD"'","every":"1h"}'
curl -fsS            "$URL/schedules?cwd=$PWD"     | jq .
curl -fsS -X DELETE "$URL/schedules/sch_xxxxxx"
curl -fsS -X POST   "$URL/schedules/sch_xxxxxx/pause"  -H 'content-type: application/json' -d '{}'
curl -fsS -X POST   "$URL/schedules/sch_xxxxxx/resume" -H 'content-type: application/json' -d '{}'
```

When a schedule's workflow file is missing or fails to parse at fire time, the dispatcher records `fact.schedule_invalid_workflow` on `daemon_events` and auto-pauses the schedule. Fix the file and `schedule resume` to bring it back. Transient run failures (provider error, halted run) do NOT pause the schedule — maintenance workflows are idempotent; one bad fire isn't a reason to disable the cadence.

---

## 7. Anti-patterns

- **Don't spam steer.** 5 steering intents in 30s usually means `cancel` + re-enqueue with a better prompt. The runtime halts with `reason:"abort_loop"` after 5 consecutive aborts without progress anyway.
- **Don't tail SSE forever.** Open streams keep the server's goroutine budget busy; the CLI terminates on terminal facts.
- **Don't write intents the user didn't ask for.** Steering / pausing / cancelling / unquarantining without explicit go-ahead risks losing work or changing external state. Present evidence, let the user decide.
- **Don't assume one daemon.** Parallel swarms (different `--db`) coexist. `curl -fsS "$URL/health" | jq .storePath` echoes the path you're hitting.
- **Don't treat `queued` as broken.** No daemon = no dispatch. Check the heartbeat first.

---

## Cheat sheet

```sh
# Discover
URL=$(sqlite3 -readonly ~/.swarm/swarm.db "SELECT http_url FROM daemon_lock;")
curl -fsS "$URL/health" | jq .

# Enqueue + watch
bun run swarm run change --input="…"

# Manual enqueue
SHA=$(curl -fsS -X POST "$URL/workflows" -H 'content-type: application/json' \
   -d "$(jq -n --arg n change --rawfile s path/to/workflow.dot '{name:$n, dotSource:$s}')" | jq -r .sha)
RUN=$(curl -fsS -X POST "$URL/runs" -H 'content-type: application/json' \
   -d "$(jq -n --arg sha "$SHA" --arg in "…" --arg cwd "$PWD" '{workflowSha:$sha, input:$in, cwd:$cwd}')" | jq -r .runId)

# Status — runStatus is lifecycle (queued|running|completed|halted|…), status is outcome (success|fail|null).
curl -fsS "$URL/runs/$RUN" | jq '{runStatus, status, currentNode, costUsd}'

# Intents (each returns {seq})
curl -fsS -X POST "$URL/runs/$RUN/steer"        -d '{"text":"…"}'                                  -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/pause"        -d '{}'                                            -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/cancel"       -d '{"reason":"…"}'                                -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/human"        -d '{"route":"A"}'                                 -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/resume"       -d '{}'                                            -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/unquarantine" -d '{"resolution":"cancel","note":"…"}'            -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/priority"     -d '{"newPriority":10}'                            -H 'content-type: application/json'

# Schedules (proposal: docs/proposals/scheduled-runs.md)
bun run swarm schedule add <workflow> --every 1h          # create + fire immediately
bun run swarm schedule list [--cwd <dir>]                  # tabular health view
bun run swarm schedule pause | resume | rm <sch_id>
```

For diagnosis after terminal state, switch to swarm-debug. This skill drives runs forward; that one looks backward.
