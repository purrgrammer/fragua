---
name: swarm-debug
description: Post-mortem a swarm run. Load this when the user pastes a run id, asks "why did run X fail/hang/halt/pause", "what happened to <run>", "debug this run", "analyze logs for run …", "is that run stuck", or when steering/unquarantine decisions need evidence. Teaches swarm-instance discovery (where is the SQLite store and the HTTP server, if any), resolving partial run ids, reading the run_state projection, decoding the fact-event taxonomy, mining the messages transcript for prompt/context failures, inspecting artifacts and LLM step snapshots, process-level checks (daemon_lock, zombies), and a failure-mode playbook (halt reasons, abort loops, orphan side effects, HITL pauses, schema drift). Assumes Claude Code with Bash / Read / Grep and direct filesystem + SQLite access to the repo.
version: 0.1.0
---

# swarm-debug — run post-mortem procedure

The goal is to go from a run id to a one-paragraph cause with evidence (event seq + payload), in the fewest reads. Follow the fast path first; only zoom into messages / artifacts / steps when the event log is inconclusive.

Authoritative references (for anything not here): `docs/SPEC.md` §3 (primitives + lifecycle), `docs/ARCHITECTURE.md` §2 (schema) + §3 (event taxonomy), `docs/handler-contract.md` (handler replay semantics).

---

## Fast path (do this first)

1. **Locate the store.** `ls .swarm/` → expect `swarm.db` (+ optional `serve.json`, `wal`, `shm`). If missing, you're not in a swarm cwd; ask the user.
2. **Pick a read path.** If `.swarm/serve.json` exists and `curl -fsS "$(jq -r .url .swarm/serve.json)/health"` answers, use the HTTP API; otherwise read SQLite directly. Both reveal the same projection — pick whichever the environment allows.
3. **Summarise the run.** Pull `run_state` + the tail of `events`. The last `fact.*` is usually the story.

```sh
# URL only valid if serve.json exists
URL=$(jq -r .url .swarm/serve.json 2>/dev/null)
RUN=<run-id>                        # or a prefix; resolve first, see below

# If HTTP is up:
curl -fsS "$URL/runs/$RUN" | jq '{status, currentNode: .currentNode, title, totalCostUsd, totalTokens, version}'
curl -fsS "$URL/runs/$RUN/events.json" | jq '.[-20:] | map({seq, type, payload})'

# If not, go to the store directly:
sqlite3 -readonly .swarm/swarm.db <<'SQL'
.mode json
SELECT run_id, status, current_node, version, workflow_sha,
       datetime(enqueued_at/1000,'unixepoch','localtime') AS enqueued,
       datetime(node_started_at/1000,'unixepoch','localtime') AS node_started,
       datetime(updated_at/1000,'unixepoch','localtime') AS updated,
       total_cost_usd, total_tokens, routing, metrics
FROM run_state WHERE run_id LIKE '<RUN>%';
SQL
```

After step 3 you know: current status, which node (if any), when it last moved, and the most recent fact. For `completed` / `cancelled` runs the story is short. For everything else, keep going.

---

## 1. Locate the swarm instance

Swarm is single-machine, single-DB. One SQLite file is the coordination surface; the daemon + server are two processes that poll it. Anything the UI shows is derived from it.

```sh
ls -la .swarm/                       # swarm.db, swarm.db-wal, swarm.db-shm, serve.json (optional)
cat .swarm/serve.json 2>/dev/null    # {url, origin, port, pid, storePath, webDistDir}
```

`serve.json` is written by `swarm serve` on start. It may be **stale** if the server died ungracefully — confirm liveness with `/health` before trusting it:

```sh
URL=$(jq -r .url .swarm/serve.json 2>/dev/null)
[ -n "$URL" ] && curl -fsS --max-time 2 "$URL/health" | jq .
```

For a non-default layout, ask the user which DB path they meant (the CLI accepts `--db /path/swarm.db`; parallel swarms are supported).

### Daemon liveness

```sh
sqlite3 -readonly .swarm/swarm.db <<'SQL'
.mode column
SELECT pid, hostname,
       datetime(started_at/1000,'unixepoch','localtime') AS started,
       datetime(heartbeat_at/1000,'unixepoch','localtime') AS last_beat,
       (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS seconds_since_beat
FROM daemon_lock;
SQL
```

- `seconds_since_beat` > 30s → daemon is presumed dead (`LOCK_TTL_MS = 30s`). Runs in `running` may be orphaned until the next daemon start sweeps them.
- No rows → no daemon has ever claimed the lock, or a shutdown released it cleanly. Runs sit `queued` until one starts.
- `ps -p <pid>` confirms the process actually exists.

Server liveness doesn't block reads — web + intent writes work daemon-down.

---

## 2. Resolve the run id

Run ids are long. Users paste prefixes. Resolve before anything else:

```sh
sqlite3 -readonly .swarm/swarm.db \
  "SELECT run_id, status, current_node,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state WHERE run_id LIKE '<prefix>%'
   ORDER BY updated_at DESC LIMIT 5;"
```

Multiple matches → show the user, ask which. Zero matches → check they're pointing at the right `--db`.

For "the most recent run" / "the one that failed a minute ago":

```sh
sqlite3 -readonly .swarm/swarm.db \
  "SELECT run_id, status, current_node, title,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state ORDER BY updated_at DESC LIMIT 10;"
```

---

## 3. Read the ending first

Every run has a terminal fact or a suspensive state. Find it before walking the timeline.

```sh
sqlite3 -readonly .swarm/swarm.db <<SQL
.mode line
SELECT seq, type, writer,
       datetime(ts/1000,'unixepoch','localtime') AS at,
       payload
FROM events
WHERE run_id='<RUN>' AND type IN (
  'fact.run_completed','fact.run_halted','fact.run_cancelled',
  'fact.run_quarantined','fact.run_paused_hitl',
  'fact.node_aborted','fact.handler_timeout_leaked',
  'fact.side_effect_failed'
)
ORDER BY seq;
SQL
```

The last row here almost always names the cause. Cross-reference with the **Failure-mode playbook** (§7) to turn the `reason` code into a diagnosis.

---

## 4. Walk the event timeline

If the ending is ambiguous (e.g. `fact.run_halted { reason: "error" }` with no detail) or you need the *why* behind the *what*, read the event stream end-to-front:

```sh
# HTTP
curl -fsS "$URL/runs/$RUN/events.json" | jq '.[] | {seq, type, payload, at: .ts}'

# SQLite — prefer chunks, events may be in the thousands on long runs
sqlite3 -readonly .swarm/swarm.db <<SQL
.mode json
SELECT seq, type, writer,
       datetime(ts/1000,'unixepoch','localtime') AS at,
       payload
FROM events WHERE run_id='<RUN>'
ORDER BY seq DESC LIMIT 100;
SQL
```

**What to look for**, in order:

- **Intent writes** (`intent.*`, `writer='web'`) that precede an abort — e.g. `intent.pause_requested` just before `fact.node_aborted { cause: "pause" }` explains the pause cleanly.
- **`fact.node_aborted { cause }`** — `"steer"`, `"pause"`, `"cancel"`, `"timeout"`, `"shutdown"`, `"abort_loop"`. Steer aborts always pair with a prior `intent.steering_requested`; timeouts do not.
- **Repeated `fact.node_started { iteration: N }` on the same node** — loop through backward conditional edges. Hit on `max_retries` → `fact.run_halted { reason: "max_retries_exceeded" }`.
- **`fact.side_effect_intent` without a matching `fact.side_effect_done`/`_failed`** by `idempotencyKey` — crash between the two quarantines the run on next daemon start. This is the orphan-side-effect invariant (ARCHITECTURE §1.1).
- **`fact.handler_timeout_leaked`** — the executor hard-timed-out a handler that ignored `ctx.signal`. Handler bug; see `docs/handler-contract.md` §4 rule 1.
- **`fact.daemon_takeover`** — another daemon reclaimed a stale lock. Expect to see `fact.run_requeued_after_crash` nearby on in-flight runs.
- **`agent.info { event: "thread_rehydrated", thread_id, message_count }`** — a codergen node picked up a `thread_id` with prior messages that were not written by this backend instance (either a fresh node sharing the thread with a prior one, or a true daemon restart). Fidelity is invariant across this; the Agent's `initialState.messages` is seeded byte-identical to the pre-rehydrate state. Informational — not a warning. If you see this during a "why did my run skip context?" investigation, the answer is it didn't: the transcript was restored in full.

Observability event types outside the fact/intent union (`llm.start`, `llm.text_delta`, `llm.done`, `cost.recorded`, `summary.*`, `agent.info`, `agent.warning`) are stamped with `nodeId` + `iteration` and fold into the step snapshot — don't try to read them raw, use §6.

---

## 5. Read the messages transcript

The `messages` table stores pi-agent-core `AgentMessage` objects as JSON (§I9) — the same shape pi-ai hands back at `message_end` and accepts as `priorMessages`. Block structure round-trips losslessly: text, thinking (with `thinkingSignature` + `redacted`), toolCall (with `thoughtSignature`), toolResult (with `toolCallId` pairing), plus swarm's `SystemPromptMessage` custom type (`role:"system"`) for the assembled per-call system prompt.

Reach for the transcript when:

- A codergen node produced the wrong output → read its `content[]` blocks.
- A node aborted with a sentinel (`<abort>…</abort>`) → the reason is in an assistant `TextContent` block.
- A prompt template failed to substitute (`${context.foo}` appeared literally) → visible on `role:"user"` rows.
- Context management is suspect → read the `role:"system"` row for the full assembled prompt, plus preceding turns.
- Tool calls need pairing — `assistant.content[i]` with `type:"toolCall"` carries `{id, name, arguments}`; the following `role:"toolResult"` row carries `toolCallId` matching that id.

Column layout: `content` is the JSON-serialized `AgentMessage` (validated by `CHECK(json_valid)`). `role` is a STORED generated column extracted from `$.role` — indexable, queryable without parsing. `node_id` + `iteration` are swarm's projection of which graph node emitted the turn.

```sh
# HTTP — returns AgentMessage[] JSON directly.
curl -fsS "$URL/runs/$RUN/messages" | jq '.[] | {ordinal, role: .content.role, nodeId, iteration}'
curl -fsS "$URL/runs/$RUN/messages" | jq '.[] | {ordinal, role: .content.role, blocks: (.content.content // []) | map(.type)}'
curl -fsS "$URL/runs/$RUN/messages?nodeId=plan" | jq '.'

# SQLite — use json_extract for shape probes, or just pretty-print.
sqlite3 -readonly .swarm/swarm.db <<SQL
.mode line
SELECT ordinal, role, node_id, iteration, length(content) AS bytes
FROM messages WHERE run_id='<RUN>'
ORDER BY ordinal;
SQL

# Show the full JSON of one row
sqlite3 -readonly .swarm/swarm.db \
  "SELECT content FROM messages WHERE run_id='<RUN>' AND ordinal=<N>;" | jq .

# Inside-JSON queries (role census, tool_call count per row)
sqlite3 -readonly .swarm/swarm.db <<SQL
.mode column
SELECT role, COUNT(*) AS n FROM messages WHERE run_id='<RUN>' GROUP BY role;
SQL
```

**Notes on what each role tells you:**

- `role='system'` — the full assembled system prompt for that node-iteration's LLM call, stored as a swarm-specific `SystemPromptMessage` custom type (`{role:"system", content: string, timestamp}`). Written by `PiCodergenBackend` to keep `llm.start` under the 4KB event cap. `handler-bridge.loadPriorMessagesForThread` filters these out before feeding priorMessages to pi-ai, which carries the system prompt separately.
- `role='user'` — pi-ai `UserMessage`. `content` is `string | (TextContent | ImageContent)[]`. The substituted prompt the node's `.dot` `prompt = "…"` compiled into. Verify `$ARGUMENTS`, `$nodeId.output`, `${context.*}` all resolved.
- `role='assistant'` — pi-ai `AssistantMessage`. `content` is `(TextContent | ThinkingContent | ToolCall)[]` in block order. `<abort>reason</abort>` and `<promise>SENTINEL</promise>` live in `TextContent.text`. Thinking blocks carry `thinkingSignature` (Anthropic Extended Thinking) + optional `redacted`. `ToolCall` carries `{id, name, arguments}` + optional `thoughtSignature` (Gemini).
- `role='toolResult'` — pi-ai `ToolResultMessage`. `content` is `(TextContent | ImageContent)[]`. Top-level `toolCallId` pairs with the originating `assistant` message's `ToolCall.id`; `toolName` + `isError` are siblings.

The transcript is populated at every `message_end` during `PiCodergenBackend.run()`, so it reflects the live state of an in-flight run — not just terminal ones.

`thread_id` on a node shares the transcript across subsequent entries of nodes with the same `thread_id` (e.g. `build-feature.dot` uses `thread_id="dev"` to share context between `implement` and `verify`). Filter by `node_id` to narrow.

---

## 6. Inspect LLM step snapshots

`GET /runs/:id/steps` folds `llm.start` + `llm.text_delta` + `llm.done` + `cost.recorded` into one `StepSnapshot` per LLM call. It's the richest per-call artifact available from the API: resolved prompt, system prompt, allowed tools, settings, model, tokens, cost, duration. Use it when the raw event stream is too noisy and the transcript doesn't tell you *how* a call was configured.

```sh
curl -fsS "$URL/runs/$RUN/steps" | jq '.[] | {stepIdx, nodeId, iteration, model, durationMs, tokens: .tokens, costUsd}'
curl -fsS "$URL/runs/$RUN/steps" | jq '.[<idx>]'     # full snapshot incl. prompts
```

No direct SQL equivalent — steps are a pure reducer over events. If the server is down, re-implementing the fold by hand is more expensive than starting the server. Prefer `curl`.

---

## 7. Inspect artifacts

Artifacts carry per-(run, node, iteration, key) content referenced by sha256 blobs — raw tool stdout/stderr, node outputs, anything over the 4KB event payload cap. Listed on `fact.tool_completed { artifactKey }`, `fact.side_effect_done { artifactKey }`, and `fact.node_completed { outputRef }`.

```sh
sqlite3 -readonly .swarm/swarm.db <<SQL
.mode column
SELECT node_id, iteration, key, mime, a.blob_sha, b.size_bytes
FROM artifacts a JOIN blobs b ON a.blob_sha = b.sha256
WHERE a.run_id='<RUN>'
ORDER BY a.created_at;
SQL
```

Pull the body (text artifact) with:

```sh
sqlite3 -readonly .swarm/swarm.db \
  "SELECT content FROM blobs WHERE sha256=(
     SELECT blob_sha FROM artifacts
     WHERE run_id='<RUN>' AND node_id='<NODE>' AND key='<KEY>' AND iteration=<N>);" \
  | sed 's/^content = //'
```

Binary artifacts (mime ≠ text/*) — copy to disk and inspect externally; don't `cat` them in-terminal.

Conventional keys worth knowing:

- `<nodeId>:stdout` / `<nodeId>:stderr` — `tool` (parallelogram) shell-node captures.
- `output` — codergen node's final text, referenced by downstream `$nodeId.output` substitution.

---

## 8. Failure-mode playbook

Map the terminal fact to a root cause. All reason codes come from `docs/ARCHITECTURE.md` §3.

| Terminal fact | `reason` / cause | What it means |
|---|---|---|
| `fact.run_halted` | `"aborted_exit"` | A codergen agent emitted `<abort>…</abort>`. Pull the assistant turn via §5 to read it. |
| `fact.run_halted` | `"max_retries_exceeded"` | A loop (backward conditional edge) consumed the target node's `max_retries`. Check how `ctx.iteration` grew in the timeline. |
| `fact.run_halted` | `"abort_loop"` | 5 consecutive aborts without progress (`ABORT_LOOP_CEILING`). Usually repeated steer/pause or a handler failing at startup. |
| `fact.run_halted` | `"schema_drift"` | `schema_version` on the run row doesn't match the daemon's `CURRENT_SCHEMA_VERSION`. Happens to long-paused runs across swarm upgrades. Not auto-recoverable. |
| `fact.run_halted` | `"budget"` / `"max_loops"` | **Declared, not yet enforced** (see §9). If you see this in the wild it's from a handler returning `kind: "halt"` manually, not the runtime ceiling. |
| `fact.run_halted` | `"error"` | Generic handler error. `detail` is a string; cross-reference with `fact.node_aborted { cause: "error" }` on the same seq range. |
| `fact.run_quarantined` | `"orphan_side_effect"` | A crash left `fact.side_effect_intent` without a matching `_done`/`_failed`. Payload includes `orphanedIntents: seq[]`. Operator must resolve via `POST /runs/:id/unquarantine { resolution: "treat_as_done"|"retry"|"cancel", note }`. Don't auto-retry — the external effect may have succeeded. |
| `fact.run_cancelled` | — | Operator cancelled. `intentSeq` points to the `intent.cancel_requested`. |
| `fact.run_paused_hitl` | — | `wait.human` node yielded. Prompt is in the payload; resume with `POST /runs/:id/hitl { payload }`. |
| `fact.handler_timeout_leaked` | — | Handler exceeded `maxMs + LEAK_GRACE_MS` (5s) without respecting `ctx.signal`. Handler bug. The run is halted separately. |
| Status `running`, no recent fact | — | Handler may be wedged. If `node_started_at` is older than the node's `maxMs`, watchdog should have fired. If not, check daemon heartbeat (§1). |

---

## 9. Known-incomplete — don't draw conclusions from these

Per `docs/ARCHITECTURE.md` §13.1, these surfaces parse/serialize but aren't wired:

- **Budgeting.** `graph.attrs.budget_usd`, `graph.attrs.budget_tokens`, `node.attrs.max_cost_usd`, `node.attrs.max_tokens` all round-trip cleanly. `BudgetSnapshot`, `budget.warn`, `budget.stop` event types are declared. No runtime enforces them. Runs exceed declared budgets silently. **Do not** tell the user "it halted because of budget" unless `fact.run_halted { reason: "budget" }` actually appears in the events — and even then, it's a handler-level halt, not the runtime ceiling.
- **HITL inside parallel branches.** A `yield_hitl` from inside a `component` (parallel) branch is coerced to `fail` with a documented reason. Nested HITL is not supported in v1.
- **Per-node provider preflight.** `POST /runs` checks that *some* provider key is configured, not the specific provider pinned on each `node.attrs.provider`. A workflow hardcoding an unconfigured provider fails at **dispatch** with `fact.run_halted`, not at enqueue. If the user says "I enqueued a run and nothing happened", check the first `fact.*` on the run for this case.

When you find a surface that looks broken, check §13.1 before filing a bug. It may just be declared-not-wired.

---

## 10. Anti-patterns for this skill

- **Don't guess from status alone.** `status='halted'` needs the fact payload; `status='running'` needs heartbeat + `node_started_at`.
- **Don't rely on `serve.json` without pinging `/health`.** It survives crashes; the server does not.
- **Don't read `events` without `ORDER BY seq`.** The table's PK is `(run_id, seq)` and seq is per-run monotonic — any other order produces gibberish.
- **Don't dump full `messages.content` into your reply.** Previews (`substr(content, 1, 600)`) first; fetch the whole body only when the preview proves the hypothesis.
- **Don't unquarantine on the user's behalf.** `intent.unquarantine { resolution }` is a decision with external-world consequences — present the evidence, let the user pick.
- **Don't assume one daemon.** Parallel swarms (different `--db`) can coexist. Always print the `storePath` you read from so the user can verify you're looking at the right instance.

---

## Cheat sheet

```sh
# Instance
ls .swarm/
cat .swarm/serve.json
URL=$(jq -r .url .swarm/serve.json)
curl -fsS "$URL/health" | jq .

# Recent runs
sqlite3 -readonly .swarm/swarm.db \
  "SELECT run_id, status, current_node, title,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state ORDER BY updated_at DESC LIMIT 10;"

# Run summary
curl -fsS "$URL/runs/$RUN" | jq .
# or
sqlite3 -readonly .swarm/swarm.db \
  "SELECT run_id, status, current_node, version, workflow_sha, routing, metrics,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state WHERE run_id='$RUN';"

# Terminal facts first
sqlite3 -readonly .swarm/swarm.db \
  "SELECT seq, type, payload FROM events WHERE run_id='$RUN'
   AND type IN ('fact.run_completed','fact.run_halted','fact.run_cancelled',
                'fact.run_quarantined','fact.run_paused_hitl',
                'fact.node_aborted','fact.handler_timeout_leaked',
                'fact.side_effect_failed') ORDER BY seq;"

# Full timeline tail
curl -fsS "$URL/runs/$RUN/events.json" | jq '.[-50:]'

# Messages — content is AgentMessage JSON
curl -fsS "$URL/runs/$RUN/messages" | jq '.[] | {ordinal, role: .content.role, nodeId, iteration}'
curl -fsS "$URL/runs/$RUN/messages?nodeId=<NODE>" | jq

# Step snapshots (prompts, models, tokens, cost)
curl -fsS "$URL/runs/$RUN/steps" | jq '.[] | {stepIdx, nodeId, model, durationMs, tokens, costUsd}'

# Artifacts
sqlite3 -readonly .swarm/swarm.db \
  "SELECT node_id, iteration, key, mime, b.size_bytes
   FROM artifacts a JOIN blobs b ON a.blob_sha=b.sha256
   WHERE a.run_id='$RUN' ORDER BY a.created_at;"

# Daemon heartbeat
sqlite3 -readonly .swarm/swarm.db \
  "SELECT pid, hostname,
          datetime(heartbeat_at/1000,'unixepoch','localtime') AS last_beat,
          (strftime('%s','now')*1000 - heartbeat_at)/1000.0 AS seconds_ago
   FROM daemon_lock;"
```

Intent writes (steer/pause/cancel/hitl/unquarantine/priority) are *not* debugging tools — they change state. Present evidence, let the user decide whether to write one.
