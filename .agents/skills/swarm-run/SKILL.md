---
name: swarm-run
description: Drive a swarm run from enqueue to terminal state. Load this when the user says "run workflow X", "kick off build-feature", "enqueue smoke-sleep", "start a run against …", "steer this run", "pause/cancel/resume run …", "send HITL input", "unquarantine <run>", "bump priority on …", or otherwise asks to operate on live runs (not analyse completed ones — that's swarm-debug). Teaches pre-flight (daemon + server + provider credentials), the two equivalent entry points (`swarm run` CLI vs. `POST /workflows` + `POST /runs`), how to watch a run over SSE / events.json / /steps, the intent vocabulary (steer, pause, cancel, hitl, unquarantine, priority) with post-conditions for each, and the HITL resume + quarantine-resolution protocols. Assumes Claude Code with Bash / Read / curl on a swarm checkout.
version: 0.1.0
---

# swarm-run — enqueue, watch, and control a live run

The goal is to go from a workflow (`workflows/*.dot` or an ad-hoc path) to a running, observable run that you can steer safely. Prefer the CLI for interactive runs; reach for the HTTP surface when you need priority / routing / no-follow / scripting.

Authoritative references: `docs/SPEC.md` §3 (primitives + control plane), `docs/ARCHITECTURE.md` §3 (event taxonomy) + §7 (web server), `AGENTS.md` (commands).

---

## Fast path (do this first)

```sh
# 0. Pre-flight — all three must be true.
ls .swarm/ && cat .swarm/serve.json | jq .url          # store + server URL
sqlite3 -readonly .swarm/swarm.db "SELECT pid, (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS age FROM daemon_lock;"
bun run swarm providers ls                             # at least the default provider shows ✓

# 1. Run. Trailing args become $ARGUMENTS; use --input to be explicit.
bun run swarm run quick-change --input="rename foo() to bar() in packages/core"
```

The CLI does three things for you: `POST /workflows` (uploads source, returns sha), `POST /runs` (enqueue), then `GET /runs/:id/stream` (SSE tail until terminal). Terminal facts are `fact.run_completed | fact.run_halted | fact.run_cancelled | fact.run_paused_hitl | fact.run_quarantined`; the CLI exits non-zero on halt / cancel.

If the fast path works, nothing below matters. Everything after is for when it doesn't — or when you need to drive a run that's already in flight.

---

## 1. Pre-flight

Three processes, one store. Enqueue fails quietly (or loudly) if any are missing. Run each check before asking the user why nothing is happening.

```sh
# Store present
test -f .swarm/swarm.db || echo "not a swarm cwd — ask the user"

# Server up (serve.json is written by `swarm serve`)
URL=$(jq -r .url .swarm/serve.json 2>/dev/null)
[ -n "$URL" ] && curl -fsS --max-time 2 "$URL/health" | jq .

# Daemon alive. LOCK_TTL_MS=30s; anything older is presumed dead.
sqlite3 -readonly .swarm/swarm.db <<'SQL'
.mode column
SELECT pid, hostname,
       datetime(heartbeat_at/1000,'unixepoch','localtime') AS last_beat,
       (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS seconds_ago
FROM daemon_lock;
SQL

# Provider usable for the model the workflow pins
bun run swarm providers ls
# If a specific model is pinned, test it:
bun run swarm providers test anthropic claude-sonnet-4-6
```

Common failures:

- **No `serve.json`** — nothing's serving HTTP. Start it: `bun run swarm serve`.
- **Heartbeat > 30s old** — daemon is dead. Runs stay `queued` until a new daemon claims the lock. Start: `bun run swarm daemon start`.
- **Provider not credentialed** — `POST /runs` 400s with `code="provider_unavailable"`. Fix: `swarm providers add <provider>` or `swarm providers login <provider>`.
- **Model not registered** — `POST /workflows` 400s with `code="model_unresolved"`, listing offenders. Either register the model (via `~/.swarm/models.json`) or switch the workflow's `model=` attr.

All four are recoverable without editing the workflow. The user should do this — don't `swarm daemon start` on their behalf without asking; the daemon attaches to the current shell.

---

## 2. Entry points

Two equivalent surfaces. Use the CLI unless the task requires scripting / non-interactive enqueue.

### CLI (`swarm run`)

```sh
bun run swarm run <workflow.dot> [trailing positional args]  \
  [--input "…"]          # explicit $ARGUMENTS; wins over trailing args
  [--priority 10]        # higher runs first (tie-breaker in the queue)
  [--no-follow]          # enqueue and exit, print only the run id
  [--url http://…]       # override serve.json discovery
  [--db path/to/db]      # pairs with `swarm serve --db` for parallel swarms
```

Ergonomics: trailing positional args are joined with spaces into `$ARGUMENTS`. `--input` always wins. The run id prints immediately; terminal facts print colorised as they stream.

### HTTP (POST /workflows then POST /runs)

Use when you need arbitrary `routing`, scripted enqueue, or multiple runs in flight. The CLI is just a thin client over this.

```sh
URL=$(jq -r .url .swarm/serve.json)

# 1. Upload (idempotent — sha is content-addressed).
SHA=$(curl -fsS -X POST "$URL/workflows" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg n quick-change --rawfile s .swarm/workflows/quick-change.dot \
        '{name:$n, dotSource:$s}')" | jq -r .sha)

# 2. Enqueue. `input` lands in routing.input → substituted as $ARGUMENTS.
RUN=$(curl -fsS -X POST "$URL/runs" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg sha "$SHA" --arg in "rename foo() to bar()" \
        '{workflowSha:$sha, priority:5, input:$in}')" | jq -r .runId)
echo "$RUN"

# 3. Tail. `Last-Event-ID` resumes from a known seq on reconnect.
curl -N "$URL/runs/$RUN/stream" -H 'Accept: text/event-stream'
```

`workflowSha` is a sha256 of the DOT source — uploading the same source twice returns the same sha, so re-enqueue is cheap. `runId` is a ULID when omitted; pass `runId` in the body to use your own (duplicate → 400).

---

## 3. Watch a run

Three surfaces, picked by what you're watching for:

| Surface | Use when | Cost |
|---|---|---|
| `GET /runs/:id/stream` (SSE) | You need *live* progress. Terminates on disconnect. | long-lived socket |
| `GET /runs/:id/events.json` | Point-in-time snapshot; scripting; diffing with a prior snapshot. | one request |
| `GET /runs/:id/steps` | You want per-LLM-call snapshots (prompt, model, tokens, cost). | one request, reducer fold |
| `GET /runs/:id` | Projection summary (status, current node, totals). Cheap status poll. | one request |

Live tail example:

```sh
curl -N "$URL/runs/$RUN/stream" -H 'Accept: text/event-stream' \
  | awk '/^event:/{e=$2} /^data:/{print e" "$0}'   # rough decoder; swap for jq if needed
```

Point-in-time:

```sh
curl -fsS "$URL/runs/$RUN" | jq '{status, currentNode: .currentNode, totalCostUsd, totalTokens}'
curl -fsS "$URL/runs/$RUN/events.json" | jq '.[-20:] | map({seq, type, payload})'
curl -fsS "$URL/runs/$RUN/steps" | jq '.[] | {stepIdx, nodeId, model, durationMs, tokens, costUsd}'
```

For running-but-silent runs: if the last event is `fact.node_started` with no follow-up in `maxMs`, the supervisor's watchdog should have fired — if it hasn't, the daemon is wedged. Jump to swarm-debug.

---

## 4. Control plane — the intent vocabulary

Every operator action is an HTTP POST that appends an `intent.*` event. No OCC: intents are **always appendable** (SPEC §3.5). The daemon picks them up on the next supervisor tick (~50ms).

All six endpoints return `{ seq }` — the sequence number assigned to the intent. Quote it in any follow-up so the user can find the action in the event stream.

| POST | Body | Written intent | Post-condition | When to use |
|---|---|---|---|---|
| `/runs/:id/steer` | `{text: "…"}` | `intent.steering_requested` | Handler aborts with `cause:"steer"`; next dispatch sees the steering in the thread. | Push a redirection into a running codergen node without cancelling the run. |
| `/runs/:id/pause` | `{}` | `intent.pause_requested` | Handler aborts with `cause:"pause"`; run transitions to `paused_hitl`. | Stop forward progress without losing the run. Resume with `/hitl`. |
| `/runs/:id/cancel` | `{reason?: "…"}` | `intent.cancel_requested` | Handler aborts with `cause:"cancel"`; terminal `fact.run_cancelled`. | Kill the run. Unrecoverable. |
| `/runs/:id/hitl` | `{input: <any>}` | `intent.hitl_input` | If `paused_hitl` (from pause or a `wait.human` node): run transitions back to `queued`; the next dispatch of the paused node sees `context.hitl.<nodeId> = input`. | Resume a paused run; answer a human-gate. |
| `/runs/:id/unquarantine` | `{resolution: "treat_as_done"\|"retry"\|"cancel", note?: "…"}` | `intent.unquarantine` | Daemon's next sweep resolves the orphan side effect per `resolution`. | Only when `status='quarantined'`. Decision has external-world consequences — see §6. |
| `/runs/:id/priority` | `{newPriority: N, note?: "…"}` | `intent.priority_adjusted` | Queue ordering updated. Already-running runs unaffected. | Jump a queued run ahead of the line. |

### Steering

Steering injects text that the next LLM call sees in the prior-messages thread. The current handler is aborted (lossless — pi-agent-core keeps what it had) and re-dispatched. Use small, specific nudges — "the plan should also cover `packages/web`", "don't edit docs this round". Long essays are usually the wrong tool; prefer `cancel` + a new run with better `$ARGUMENTS`.

```sh
curl -fsS -X POST "$URL/runs/$RUN/steer" \
  -H 'content-type: application/json' \
  -d '{"text":"skip the migration step; the schema is already at head"}' | jq .seq
```

Post-condition to wait for: `fact.node_aborted { cause: "steer", intentSeq: <the seq you got back> }` → `fact.node_started` for the same node (same `nodeId`, `iteration` bumped).

### Pause + resume

Pause is steer-without-text: abort the current handler and flip the run to `paused_hitl`. The user (or you, on their behalf) resumes with `/hitl { input }`. The paused node's next dispatch reads the input from `context.hitl.<nodeId>`.

```sh
curl -fsS -X POST "$URL/runs/$RUN/pause"  -H 'content-type: application/json' -d '{}'
# … user thinks …
curl -fsS -X POST "$URL/runs/$RUN/hitl"   -H 'content-type: application/json' \
  -d '{"input":"proceed — the config at packages/web/vite.config.ts is correct"}'
```

### Cancel

Cancel is final: terminal `fact.run_cancelled`, no resume path. Prefer `pause` + decide later if you're unsure.

### HITL inputs (wait.human nodes)

Workflows can also pause themselves via a `hexagon`-shaped `wait.human` node (see swarm-author §11). Same resume mechanism: post to `/hitl`. The node's prompt tells the operator what shape of input it expects.

```sh
# After `fact.run_paused_hitl { nodeId: "review", prompt: "APPROVED | REVISE: <note>" }`:
curl -fsS -X POST "$URL/runs/$RUN/hitl" \
  -H 'content-type: application/json' \
  -d '{"input":"APPROVED"}'
```

The input lands at `context.hitl.<nodeId>`. Edge conditions like `[condition="context.hitl.review=APPROVED"]` route on literal match — no parser-node required.

### Priority

Higher = earlier. Ties break by enqueue time. Running runs don't re-sort. Use for queue-management, not for mid-run steering.

---

## 5. HITL resume protocol

Runs sit in `paused_hitl` until you feed them. The payload of `fact.run_paused_hitl` tells you what the node wanted:

```sh
curl -fsS "$URL/runs/$RUN/events.json" \
  | jq '[.[] | select(.type=="fact.run_paused_hitl")] | last'
# { seq, type, payload: { nodeId, prompt, options? }, … }
```

Respond with the shape the prompt asks for. If the workflow used `review-parallel.dot`-style `APPROVE | REJECT` tokens, send the literal token as a string. If the payload carries `options`, those are the suggested values — but the endpoint accepts any JSON, so don't be clever.

Present the decision to the user — don't answer HITL on their behalf unless they've explicitly delegated it.

---

## 6. Quarantine resolution

A run lands in `quarantined` when the startup sweep finds `fact.side_effect_intent` without a matching `_done`/`_failed`. The external effect may have succeeded, failed, or never reached the provider — swarm can't tell from the crash. Operator decides.

```sh
# Identify the orphan intents:
curl -fsS "$URL/runs/$RUN/events.json" \
  | jq '[.[] | select(.type=="fact.run_quarantined")] | last | .payload.orphanedIntents'
# Walk each orphan by seq to see what it was:
curl -fsS "$URL/runs/$RUN/events.json" \
  | jq --argjson seqs '[<paste seqs>]' '.[] | select(.seq == $seqs[])'
```

Resolutions:

- `treat_as_done` — assume the effect completed. Use when provider idempotency is strong and the orphan's `idempotencyKey` matches a known success externally.
- `retry` — replay the effect. Use when the provider is idempotent *and* you've verified the external state is consistent with a re-try.
- `cancel` — stop the run. Use when the blast radius is unclear or the user wants to intervene manually.

```sh
curl -fsS -X POST "$URL/runs/$RUN/unquarantine" \
  -H 'content-type: application/json' \
  -d '{"resolution":"cancel","note":"verified the external effect via <evidence>; human will retry by hand"}'
```

Present the options and evidence to the user. Let them pick. Never auto-choose.

---

## 7. Parallel / scripted operations

Multiple runs in flight is the normal case; the daemon has concurrency (`--concurrency N`, default 4). A few idioms:

```sh
# Enqueue a batch of smoke runs to exercise concurrency.
for _ in 1 2 3 4 5; do
  bun run swarm run smoke-sleep --no-follow
done

# Watch all currently-running runs' status:
curl -fsS "$URL/runs?status=running" | jq '.[] | {runId, currentNode, updated: .updatedAt}'

# Multi-run streaming — tail each in its own subshell.
for R in run_a run_b; do
  curl -N "$URL/runs/$R/stream" &
done
wait
```

For long-running batches, prefer `--no-follow` + polling `/runs/:id` over N open SSE streams.

---

## 8. Running against a non-default store

`swarm serve --db /path/to/other.db` writes `serve.json` next to that DB. The CLI discovers it via `--db`:

```sh
bun run swarm serve  --db /tmp/other.swarm/swarm.db &
bun run swarm daemon start --db /tmp/other.swarm/swarm.db &
bun run swarm run ci-gate --db /tmp/other.swarm/swarm.db
```

This is how parallel swarms coexist on one machine. Always pass `--db` consistently; mixing a CLI invocation with the default db against a non-default daemon will silently target the wrong store.

---

## 9. Anti-patterns

- **Don't spam steer.** 5 steering intents in 30s usually means `cancel` + re-enqueue with a better prompt is the right answer. After 5 consecutive aborts without forward progress, the runtime halts with `reason:"abort_loop"` anyway.
- **Don't tail SSE forever.** The CLI terminates on terminal facts; custom `curl -N` loops must too. Open streams keep the server's goroutine budget busy.
- **Don't write intents the user didn't ask for.** Steering, pausing, cancelling, or unquarantining without an explicit go-ahead risks losing work or changing external state. Present evidence, let the user decide.
- **Don't assume a run's store.** If multiple `serve.json` files exist on the machine, confirm which URL you're hitting before writing intents. `curl -fsS "$URL/health" | jq .storePath` echoes the path.
- **Don't edit `serve.json` by hand.** It's server-owned; the server rewrites it on start. Edit → next start overwrites.
- **Don't treat `queued` as broken.** No daemon = no dispatch. Check the heartbeat first (§1).

---

## Cheat sheet

```sh
# Pre-flight
URL=$(jq -r .url .swarm/serve.json); curl -fsS "$URL/health" | jq .
sqlite3 -readonly .swarm/swarm.db "SELECT (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS age FROM daemon_lock;"
bun run swarm providers ls

# Enqueue + watch
bun run swarm run quick-change --input="…"

# Manual enqueue
SHA=$(curl -fsS -X POST "$URL/workflows" -H 'content-type: application/json' \
   -d "$(jq -n --arg n quick-change --rawfile s .swarm/workflows/quick-change.dot '{name:$n, dotSource:$s}')" | jq -r .sha)
RUN=$(curl -fsS -X POST "$URL/runs" -H 'content-type: application/json' \
   -d "$(jq -n --arg sha "$SHA" --arg in "…" '{workflowSha:$sha, input:$in}')" | jq -r .runId)

# Status
curl -fsS "$URL/runs/$RUN" | jq '{status, currentNode, totalCostUsd, totalTokens}'

# Intents
curl -fsS -X POST "$URL/runs/$RUN/steer"         -d '{"text":"…"}'       -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/pause"         -d '{}'                  -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/cancel"        -d '{"reason":"…"}'      -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/hitl"          -d '{"input":"APPROVED"}' -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/unquarantine"  -d '{"resolution":"cancel","note":"…"}' -H 'content-type: application/json'
curl -fsS -X POST "$URL/runs/$RUN/priority"      -d '{"newPriority":10}'  -H 'content-type: application/json'
```

For diagnosis after terminal state, switch to swarm-debug. This skill drives runs forward; that one looks backward.
