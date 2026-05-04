---
name: swarm-debug
description: Post-mortem a swarm run. Load this when the user pastes a run id, asks "why did run X fail/hang/halt/pause", "what happened to <run>", "debug this run", "analyze logs for run …", "is that run stuck", or when steering/unquarantine decisions need evidence. Teaches swarm-instance discovery (where is the SQLite store), resolving partial run ids, reading the run_state projection, decoding the fact-event taxonomy, mining the messages transcript for prompt/context failures, inspecting artifacts and LLM step snapshots, process-level checks (daemon_lock, zombies), and a failure-mode playbook (halt reasons, abort loops, orphan side effects, HITL pauses, schema drift). Assumes Claude Code with Bash / Read / Grep and direct filesystem + SQLite access.
version: 0.2.1
---

# swarm-debug — run post-mortem procedure

The goal is to go from a run id to a one-paragraph cause with evidence (event seq + payload), in the fewest reads. Follow the fast path first; only zoom into messages / artifacts / steps when the event log is inconclusive.

Authoritative references: `docs/SPEC.md` §3 (primitives + lifecycle), `docs/ARCHITECTURE.md` §2 (schema) + §3 (event taxonomy), `docs/handler-contract.md` (handler replay semantics).

---

## Fast path

1. **Locate the store.** Default is `~/.swarm/swarm.db` (harness). The CI primitive (`swarm daemon --db <path>`) writes elsewhere — ask the user if `~/.swarm/swarm.db` is missing.
2. **Pick a read path.** If `daemon_lock.http_url` is populated and `/health` answers, use HTTP. Otherwise read SQLite directly. Both reveal the same projection.
3. **Summarise the run.** Pull `run_state` + the tail of `events`. The last `fact.*` is usually the story.

```sh
DB=~/.swarm/swarm.db                      # harness default; override with the user's --db
URL=$(sqlite3 -readonly "$DB" "SELECT http_url FROM daemon_lock;")
RUN=<run-id>                              # or a prefix; resolve first (§2)

# If HTTP is up:
[ -n "$URL" ] && curl -fsS "$URL/runs/$RUN" | jq '{status, currentNode, title, costUsd, totalTokens: (.inputTokens + .outputTokens), version}'
[ -n "$URL" ] && curl -fsS "$URL/runs/$RUN/events.json" | jq '.[-20:] | map({seq, type, payload})'

# Direct SQL fallback:
sqlite3 -readonly "$DB" <<SQL
.mode json
SELECT run_id, status, current_node, version, workflow_sha, cwd,
       datetime(enqueued_at/1000,'unixepoch','localtime') AS enqueued,
       datetime(node_started_at/1000,'unixepoch','localtime') AS node_started,
       datetime(updated_at/1000,'unixepoch','localtime') AS updated,
       total_cost_usd, billed_tokens, routing, metrics
FROM run_state WHERE run_id LIKE '$RUN%';
SQL
```

After this you know: current status, which node (if any), when it last moved, and the most recent fact. For `completed` / `cancelled` runs the story is short. For everything else, keep going.

---

## 1. Locate the swarm instance

One SQLite file is the coordination surface; the daemon + HTTP server are processes that poll it. The UI is derived from it.

```sh
# Default (harness)
ls -la ~/.swarm/

# CI primitive (per-cwd)
ls -la <cwd>/.swarm/
```

Confirm liveness via the lock row:

```sh
sqlite3 -readonly ~/.swarm/swarm.db <<'SQL'
.mode column
SELECT pid, hostname, http_url, http_port,
       datetime(started_at/1000,'unixepoch','localtime') AS started,
       datetime(heartbeat_at/1000,'unixepoch','localtime') AS last_beat,
       (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS seconds_since_beat
FROM daemon_lock;
SQL
```

- `seconds_since_beat` > 30s → daemon presumed dead (`LOCK_TTL_MS = 30s`). `running` runs may be orphaned until the next daemon start sweeps them.
- No rows → no daemon has ever claimed the lock, or shutdown released it cleanly. Runs sit `queued`.
- `http_url` NULL → daemon up but no HTTP (the user is on the CI primitive: `swarm daemon` + `swarm serve` separately, or harness mid-startup). `<cwd>/.swarm/serve.json` is the fallback.
- `ps -p <pid>` confirms the process actually exists.

Server liveness doesn't block reads — web + intent writes work daemon-down.

---

## 2. Resolve the run id

Run ids are long. Users paste prefixes.

```sh
sqlite3 -readonly "$DB" \
  "SELECT run_id, status, current_node, cwd,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state WHERE run_id LIKE '<prefix>%'
   ORDER BY updated_at DESC LIMIT 5;"
```

Multiple matches → show the user, ask which. Zero matches → check they're pointing at the right `--db`.

Most-recent run shortcut:

```sh
sqlite3 -readonly "$DB" \
  "SELECT run_id, status, current_node, title, cwd,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state ORDER BY updated_at DESC LIMIT 10;"
```

---

## 3. Read the ending first

Every run has a terminal fact or a suspensive state. Find it before walking the timeline.

```sh
sqlite3 -readonly "$DB" <<SQL
.mode line
SELECT seq, type, writer,
       datetime(ts/1000,'unixepoch','localtime') AS at,
       payload
FROM events
WHERE run_id='$RUN' AND type IN (
  'fact.run_completed','fact.run_halted','fact.run_cancelled',
  'fact.run_quarantined','fact.run_paused_hitl',
  'fact.node_aborted','fact.handler_timeout_leaked',
  'fact.side_effect_failed'
)
ORDER BY seq;
SQL
```

The last row almost always names the cause. Cross-reference with the **Failure-mode playbook** (§7).

---

## 4. Walk the event timeline

If the ending is ambiguous (`fact.run_halted { reason: "error" }` with no detail) or you need the *why* behind the *what*:

```sh
# HTTP
curl -fsS "$URL/runs/$RUN/events.json" | jq '.[] | {seq, type, payload, at: .ts}'

# SQL — chunks; events run into thousands on long runs.
sqlite3 -readonly "$DB" <<SQL
.mode json
SELECT seq, type, writer, datetime(ts/1000,'unixepoch','localtime') AS at, payload
FROM events WHERE run_id='$RUN' ORDER BY seq DESC LIMIT 100;
SQL
```

What to look for:

- **Intent writes** (`intent.*`, `writer='web'`) preceding an abort — e.g. `intent.pause_requested` just before `fact.node_aborted { cause:"pause" }` explains the pause cleanly.
- **`fact.node_aborted { cause }`** — `"steer" | "pause" | "cancel" | "timeout" | "shutdown" | "abort_loop"`. Steer aborts pair with a prior `intent.steering_requested`; timeouts don't.
- **Repeated `fact.node_started { iteration: N }` on the same node** — loop through backward conditional edges. Hit on `max_retries` → `fact.run_halted { reason: "max_retries_exceeded" }`.
- **`fact.side_effect_intent` without a matching `_done`/`_failed`** by `idempotencyKey` — crash between the two quarantines on next daemon start. Orphan-side-effect invariant (ARCHITECTURE §1.1).
- **`fact.handler_timeout_leaked`** — executor hard-timed-out a handler that ignored `ctx.signal`. Handler bug (`docs/handler-contract.md` §4 rule 1).
- **`fact.daemon_takeover`** — another daemon reclaimed a stale lock. Expect `fact.run_requeued_after_crash` nearby on in-flight runs.
- **`agent.info { event: "thread_rehydrated", thread_id, message_count }`** — a codergen node picked up a `thread_id` with prior messages from a previous backend instance. Fidelity is invariant; the Agent's `initialState.messages` is seeded byte-identical. Informational. If you see this during a "why did my run skip context?" investigation, the answer is it didn't.
- **`run_state.routing` keys worth a glance:**
  - `goal_gates.<nodeId>` — last outcome of every visited gate.
  - `goal_gates.__retries` — cumulative retarget count. Equals `max_goal_gate_retries` (default 3) → `fact.run_halted { reason: "goal_gate_unsatisfied" }`.
  - `internal.auto_resume_at` — wall-clock ms when a `paused_retry` or `paused_provider_retry` run is due to wake (one routing key powers both states; canonical declaration: `packages/core/src/types/context.ts` `AUTO_RESUME_AT_KEY`). In the past + still paused → wake-pending sweeper is wedged (check daemon heartbeat).
  - `__budget_warned.*` — tags suppressing duplicate `budget.warn` events.

Observability events outside fact/intent (`llm.start`, `llm.text_delta`, `llm.done`, `cost.recorded`, `summary.*`, `agent.info`, `agent.warning`) carry `nodeId` + `iteration` and fold into step snapshots — don't read them raw, use §5.

---

## 5. LLM step snapshots

`GET /runs/:id/steps` folds `llm.start` + `llm.text_delta` + `llm.done` + `cost.recorded` into one `StepSnapshot` per call. Richest per-call artifact: resolved prompt, system prompt, allowed tools, settings, model, tokens, cost, duration.

```sh
curl -fsS "$URL/runs/$RUN/steps" | jq '.[] | {stepIdx, nodeId, iteration, model, durationMs, tokens, costUsd}'
curl -fsS "$URL/runs/$RUN/steps" | jq '.[<idx>]'     # full snapshot incl. prompts
```

No SQL equivalent — steps are a pure reducer over events. If the server is down, prefer starting it over re-implementing the fold.

---

## 6. Read the messages transcript

`messages.content` stores pi-agent-core `AgentMessage` JSON (§I9) — same shape pi-ai accepts as `priorMessages`. Block structure round-trips losslessly: text, thinking (`thinkingSignature` + optional `redacted`), toolCall (`thoughtSignature` on Gemini), toolResult (paired by `toolCallId`), plus swarm's `SystemPromptMessage` custom type (`role:"system"`).

Reach for the transcript when:

- A codergen node produced wrong output → read its `content[]` blocks.
- A node aborted with `<abort>…</abort>` → reason in an assistant `TextContent` block.
- A prompt template failed to substitute (`${context.foo}` appeared literally) → visible on `role:"user"` rows.
- Context management is suspect → read the `role:"system"` row for the assembled prompt.
- Tool-call pairing — `assistant.content[i]` `toolCall { id, name, arguments }` pairs with the next `role:"toolResult"` row whose `toolCallId` matches.

```sh
# HTTP — returns AgentMessage[] JSON.
curl -fsS "$URL/runs/$RUN/messages" | jq '.[] | {ordinal, role: .content.role, nodeId, iteration}'
curl -fsS "$URL/runs/$RUN/messages?nodeId=plan" | jq .
curl -fsS "$URL/runs/$RUN/messages?sinceOrdinal=42&limit=50" | jq .

# SQL
sqlite3 -readonly "$DB" "SELECT ordinal, role, node_id, iteration, length(content) AS bytes
                          FROM messages WHERE run_id='$RUN' ORDER BY ordinal;"
sqlite3 -readonly "$DB" "SELECT content FROM messages WHERE run_id='$RUN' AND ordinal=<N>;" | jq .
```

Roles, in brief:

- `system` — `SystemPromptMessage { role, content, timestamp }`. Per-call assembled system prompt; written by `PiCodergenBackend` to keep `llm.start` under the 4KB event cap. Filtered out before pi-ai (which carries the system prompt separately).
- `user` — `UserMessage`. The substituted prompt the node's `prompt = "…"` compiled into. Verify `$ARGUMENTS`, `$<nodeId>.output`, `${context.*}` resolved.
- `assistant` — `AssistantMessage`. `content` is `(TextContent | ThinkingContent | ToolCall)[]` in block order. `<abort>reason</abort>` lives in a `TextContent.text`.
- `toolResult` — `ToolResultMessage`. Top-level `toolCallId` pairs back to `assistant.ToolCall.id`; `toolName` + `isError` are siblings.

`thread_id` shares the transcript across nodes that declare the same id (e.g. `change.dot`'s `cluster_dev` puts `implement` + `review` on `thread_id="dev"` so the reviewer sees the implementer's session). Filter by `node_id` to narrow.

The transcript populates at every `message_end`, so it reflects live state — not just terminal runs.

---

## 7. Inspect artifacts

Per-`(run, node, iteration, key)` content referenced by sha256 blobs — raw stdout/stderr, node outputs, anything over the 4KB event cap.

```sh
sqlite3 -readonly "$DB" <<SQL
.mode column
SELECT node_id, iteration, key, mime, a.blob_sha, b.size_bytes
FROM artifacts a JOIN blobs b ON a.blob_sha = b.sha256
WHERE a.run_id='$RUN' ORDER BY a.created_at;
SQL

# Pull the body. Blobs live on disk: <dirname(db)>/blobs/<sha[0:2]>/<sha>
SHA=$(sqlite3 -readonly "$DB" \
  "SELECT blob_sha FROM artifacts WHERE run_id='$RUN' AND node_id='<NODE>' AND key='<KEY>' AND iteration=<N>;")
cat "$(dirname "$DB")/blobs/${SHA:0:2}/$SHA"
```

Conventional keys:

- `<nodeId>:stdout` / `<nodeId>:stderr` — `tool` (parallelogram) shell captures.
- `output` — codergen node's final text, referenced downstream by `$<nodeId>.output`.

Binary artifacts (mime ≠ text/*) — copy to disk, don't `cat` in-terminal.

For "what did the run actually change in the working tree?" use the worktree endpoints — they sit on top of the run's `.swarm/worktrees/<run_id>/` directory and the preserved `swarm/runs/<run_id>` branch:

```sh
curl -fsS "$URL/runs/$RUN/tree"           | jq '.[] | select(.type=="file") | .path'   # 410 if worktree disposed without a branch; otherwise live ls
curl -fsS "$URL/runs/$RUN/blob?path=…"                                                  # raw text of one file in the worktree
curl -fsS "$URL/runs/$RUN/changes"        | jq .                                        # base..tip diff; survives worktree disposal via the preserved branch
```

---

## 8. Failure-mode playbook

| Terminal fact | `reason` / cause | What it means |
|---|---|---|
| `fact.run_halted` | `"aborted_exit"` | Codergen agent emitted `<abort>…</abort>`. Pull the assistant turn (§6). |
| `fact.run_halted` | `"max_retries_exceeded"` | Backward conditional edge consumed the target's `max_retries`. |
| `fact.run_halted` | `"goal_gate_unsatisfied"` | `goal_gate=true` node never settled in SUCCESS/PARTIAL_SUCCESS, retarget chain (SPEC §3.4) exhausted past `max_goal_gate_retries`. Authoritative source: `routing.goal_gates.<gateId>` for last outcomes, `goal_gates.__retries` for cumulative count. Payload `detail` may name the failed gate but isn't structured. |
| `fact.run_halted` | `"abort_loop"` | 5 consecutive aborts without progress (`ABORT_LOOP_CEILING`). |
| `fact.run_halted` | `"schema_drift"` | Run's `schema_version` doesn't match daemon's `CURRENT_SCHEMA_VERSION`. Long-paused run across an upgrade. Not auto-recoverable. |
| `fact.run_halted` | `"budget"` | Cumulative cost or tokens hit a declared ceiling — graph-level `budget_usd`/`budget_tokens` or node-level `max_cost_usd`/`max_tokens`. The preceding `budget.warn` event names which ceiling tripped. |
| `fact.run_halted` | `"error"` | Generic handler error. `detail` is a string; cross-reference with `fact.node_aborted { cause:"error" }`. |
| `fact.run_halted` | `"max_loops"` | `DEFAULT_MAX_LOOPS = 1000` tripped — workflow looped without aborting and without exhausting `max_retries`. |
| `fact.run_halted` | `"occ_exhausted"` | OCC retry budget exhausted on one `(nodeId, iteration)`. Payload: `occContext: { count, nodeId, iteration, lastVersion, attemptedFactType }`. |
| `fact.run_halted` | `"provider_exhausted"` | Auto-retry chain capped (5 attempts or 5 cumulative minutes). Operator decides via `intent.resume`, `intent.cancel`, or steer to a different provider. Walk the chain via `fact.provider_retry_attempted` events. |
| `fact.run_quarantined` | `"orphan_side_effect"` | Crash left `fact.side_effect_intent` without a matching `_done`/`_failed`. Payload: `orphanedIntents: seq[]`. Resolve via `intent.unquarantine`. |
| `fact.run_cancelled` | — | Operator cancelled. `intentSeq` points to `intent.cancel_requested`. |
| `fact.run_paused_hitl` | — | `wait.human` yielded. Payload: `{nodeId, label, options[]}`; resume via `/hitl`. |
| `fact.run_paused_retry` | — | Node returned `outcome=retry`. `routing.internal.auto_resume_at` (ms) tells you when wake-pending will re-queue it. Slot freed during the wait. |
| `fact.run_paused` | `reason: "operator"` | Operator hit Pause. Wake on `intent.resume`. |
| `fact.run_paused` | `reason: "provider_error"` | Manual-class provider transport error (400/401/403/404/413/422). Wake on `intent.resume` after fixing creds/request. |
| `fact.run_paused` | `reason: "payment_required"` | Provider returned 402. Top up, then `intent.resume`. |
| `fact.run_paused` | `reason: "budget"` | Local budget cap hit. Raise via `POST /runs/:id/budget`, then `intent.resume`. |
| `fact.handler_timeout_leaked` | — | Handler exceeded `maxMs + LEAK_GRACE_MS` (10s) without respecting `ctx.signal`. Handler bug. |
| Status `running`, no recent fact | — | Handler may be wedged. If `node_started_at` older than the node's `maxMs`, watchdog should have fired. If not, check daemon heartbeat (§1). |
| Status `paused_retry`, `resumeAt` in the past | — | Wake-pending sweeper hasn't fired. Daemon heartbeat (§1). |

---

## 9. Known-incomplete

Per `docs/ARCHITECTURE.md` §12.1, these surfaces parse/serialize but aren't wired:

- **HITL inside parallel branches.** A `yield_hitl` from inside a `component` coerces to `fail`. Nested HITL not supported in v1.
- **Per-node provider preflight.** `POST /runs` checks that *some* provider key is configured, not the specific provider on each node. A workflow hardcoding an unconfigured provider fails at *dispatch* with `fact.run_halted`, not at enqueue.

When something looks broken, check §12.1 first.

---

## 10. Anti-patterns

- **Don't guess from status alone.** `halted` needs the fact payload; `running` needs heartbeat + `node_started_at`.
- **Don't trust `daemon_lock.http_url` without `/health`.** It's published once at harness boot; a crash leaves stale URL columns until the next harness clears them on shutdown or next start.
- **Don't read `events` without `ORDER BY seq`.** PK is `(run_id, seq)`, per-run monotonic. Other orderings produce gibberish.
- **Don't dump full `messages.content` into your reply.** Previews first (`substr(content, 1, 600)`); fetch the whole body only when the preview proves the hypothesis.
- **Don't unquarantine on the user's behalf.** `intent.unquarantine` is a decision with external-world consequences — present evidence, let the user pick.
- **Don't assume one daemon.** Parallel swarms (different `--db`) can coexist. Always print the `storePath` so the user can verify which instance you're on.

---

## Cheat sheet

```sh
DB=~/.swarm/swarm.db
URL=$(sqlite3 -readonly "$DB" "SELECT http_url FROM daemon_lock;")
[ -n "$URL" ] && curl -fsS "$URL/health" | jq .

# Recent runs
sqlite3 -readonly "$DB" \
  "SELECT run_id, status, current_node, title, cwd,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state ORDER BY updated_at DESC LIMIT 10;"

# Run summary
curl -fsS "$URL/runs/$RUN" | jq .
sqlite3 -readonly "$DB" \
  "SELECT run_id, status, current_node, version, workflow_sha, cwd, routing, metrics,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state WHERE run_id='$RUN';"

# Terminal facts first
sqlite3 -readonly "$DB" \
  "SELECT seq, type, payload FROM events WHERE run_id='$RUN'
   AND type IN ('fact.run_completed','fact.run_halted','fact.run_cancelled',
                'fact.run_quarantined','fact.run_paused_hitl',
                'fact.node_aborted','fact.handler_timeout_leaked',
                'fact.side_effect_failed') ORDER BY seq;"

# Full timeline tail
curl -fsS "$URL/runs/$RUN/events.json" | jq '.[-50:]'

# Messages — content is AgentMessage JSON
curl -fsS "$URL/runs/$RUN/messages" | jq '.[] | {ordinal, role: .content.role, nodeId, iteration}'

# Step snapshots
curl -fsS "$URL/runs/$RUN/steps" | jq '.[] | {stepIdx, nodeId, model, durationMs, tokens, costUsd}'

# Artifacts
sqlite3 -readonly "$DB" \
  "SELECT node_id, iteration, key, mime, b.size_bytes
   FROM artifacts a JOIN blobs b ON a.blob_sha=b.sha256
   WHERE a.run_id='$RUN' ORDER BY a.created_at;"

# Daemon liveness
sqlite3 -readonly "$DB" \
  "SELECT pid, http_url, datetime(heartbeat_at/1000,'unixepoch','localtime') AS last_beat,
          (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS seconds_ago
   FROM daemon_lock;"
```

Intent writes (steer/pause/cancel/hitl/unquarantine/priority) change state — they're not debugging tools. Present evidence; let the user decide whether to write one.
