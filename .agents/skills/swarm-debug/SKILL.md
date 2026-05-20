---
name: swarm-debug
description: Post-mortem a swarm run. Load this when the user pastes a run id, asks "why did run X fail/hang/halt/pause", "what happened to <run>", "debug this run", "analyze logs for run …", "is that run stuck", or when steering/unquarantine decisions need evidence. Teaches swarm-instance discovery (where is the SQLite store), resolving partial run ids, reading the run_state projection, decoding the fact-event taxonomy, mining the messages transcript for prompt/context failures, inspecting artifacts and LLM step snapshots, process-level checks (daemon_lock, zombies), schedule and sub-agent post-mortems, and a failure-mode playbook (halt reasons, abort loops, orphan side effects, HITL pauses, schema drift). Assumes Claude Code with Bash / Read / Grep and direct filesystem + SQLite access.
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

- `seconds_since_beat` > 30s → daemon presumed dead (`DEFAULT_LOCK_TTL_MS = 30_000` ms in `packages/daemon/src/entrypoint.ts:82`). `running` runs may be orphaned until the next daemon start sweeps them.
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
  'fact.run_quarantined','fact.run_paused_human',
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
- **Repeated `fact.node_started { iteration: N }` on the same node** — loop through backward conditional edges. Hit on `max_retries` → `fact.run_paused { reason: "max_retries" }` (operator-resumable; raise via `intent.max_retries_adjusted`).
- **`fact.side_effect_intent` without a matching `_done`/`_failed`** by `idempotencyKey` — crash between the two quarantines on next daemon start. Orphan-side-effect invariant (ARCHITECTURE §1.1).
- **`fact.handler_timeout_leaked`** — executor hard-timed-out a handler that ignored `ctx.signal`. Handler bug (`docs/handler-contract.md` §4 rule 1).
- **`fact.daemon_takeover`** — another daemon reclaimed a stale lock. Expect `fact.run_requeued_after_crash` nearby on in-flight runs.
- **`agent.info { event: "thread_rehydrated", thread_id, message_count }`** — a codergen node picked up a `thread_id` with prior messages from a previous backend instance. Fidelity is invariant; the Agent's `initialState.messages` is seeded byte-identical. Informational. If you see this during a "why did my run skip context?" investigation, the answer is it didn't.
- **`run_state.routing` keys worth a glance:**
  - `goal_gates.<nodeId>` — last outcome of every visited gate.
  - `goal_gates.__retries` — cumulative retarget count. Reaches the failing gate's `max_retries` → `fact.run_paused { reason: "goal_gate" }` (operator-resumable; raise via `intent.goal_gate_adjusted`).
  - `internal.auto_resume_at` — wall-clock ms when a `paused_auto` run (reason `provider_retry` or `handler_retry`) is due to wake (one routing key powers both reasons; canonical declaration: `packages/core/src/types/context.ts` `AUTO_RESUME_AT_KEY`). In the past + still paused → wake-pending sweeper is wedged (check daemon heartbeat).
  - `__budget_warned.*` — tags suppressing duplicate `budget.warn` events.

Observability events outside fact/intent (`llm.start`, `llm.text_delta`, `llm.done`, `cost.recorded`, `summary.*`, `agent.info`, `agent.warning`) carry `nodeId` + `iteration` and fold into step snapshots — don't read them raw, use §5.

### 4.1 Fact-event quick reference

Authoritative source: `FactEvent` union in `packages/types/src/swarm-events.ts`. The §8 playbook covers terminal / blocking facts in detail; this table covers the *informational* facts you'll see walking the timeline.

| Fact type | Payload highlights | When you'd read it |
|---|---|---|
| `fact.dispatch_started` | `nodeId`, `iteration` | Marks the boundary where an executor pass picked up the run; `dispatch_started_at` on `run_state` syncs from this. Useful for active-time accounting. |
| `fact.node_started` | `nodeId`, `iteration` | Node entered. Repeated rows on the same `(nodeId, iteration)` indicate a backward conditional edge looping; cap is the node's `max_retries`. |
| `fact.node_completed` | `nodeId`, `iteration`, `outcomeStatus?`, `tokens`, `costUsd` + 4-bucket splits, `nextNode`, `outputRef?` | Node finished. `outcomeStatus="fail"` here matches against `condition="outcome=fail"` edges; the run can still continue. |
| `fact.node_aborted` | `nodeId`, `iteration`, `cause`, `partial*` | Mid-flight abort. `cause`: `steer \| pause \| cancel \| timeout \| shutdown \| abort_loop \| error`. |
| `fact.intents_folded` | `intentSeq`, `folded` | Intent fold landed. Useful when the timeline shows a steer/pause/human that didn't visibly change behaviour — read `folded` to see what the fold did. |
| `fact.message_appended` | `ordinal`, `role`, `nodeId\|null`, `iteration` | Message metadata. Don't read these raw; query `messages` (§6). |
| `fact.tool_completed` | `toolName`, `argsHash`, `artifactKey`, `preview`, `summary?` | Non-external tool result (skill-tool, agent-tool, read/edit/bash). The artifact at `artifactKey` carries the body. |
| `fact.side_effect_intent` | `nodeId`, `iteration`, `toolName`, `argsHash`, `attempt`, `idempotencyKey` | External tool dispatched. Followed by exactly one `_done` or `_failed`; missing pair → orphan-side-effect quarantine on next daemon start. |
| `fact.side_effect_done` | `idempotencyKey`, `artifactKey`, `tokens?`, `costUsd?` | External tool completed. Pair with the matching `_intent` row by `idempotencyKey`. |
| `fact.side_effect_failed` | `idempotencyKey`, `errorCode`, `retriable: bool` | External tool failed cleanly. `retriable=true` → handler will redrive; `false` → permanent. |
| `fact.run_paused_human` | `nodeId`, `text`, `routes` | Human node yield. See §8 playbook. |
| `fact.run_paused` | `reason`, reason-specific fields | Unified pause. Reasons in `AUTO_WAKE_PAUSE_REASONS` (`provider_retry`, `handler_retry`) project to `paused_auto`; rest → `paused`. See §8. |
| `fact.provider_retry_attempted` | `nodeId`, `attempt`, `httpStatus\|null`, `delayMs` | One per attempt in an auto-retry chain. Walk these to reconstruct the retry timeline before a `provider_exhausted` halt. |
| `fact.run_resumed` | `fromStatus: RunStatus`, `inputIntentSeq?` | Run left a paused/quarantined state. `inputIntentSeq` points back at the operator intent that drove the wake (when applicable). |
| `fact.run_completed` | `finalNode` | Terminal success. |
| `fact.run_halted` | `reason: HaltReason`, `detail?`, `occContext?` | Terminal failure. See §8. |
| `fact.run_cancelled` | `intentSeq` | Operator cancelled. `intentSeq` resolves the originating `intent.cancel_requested`. |
| `fact.run_quarantined` | `reason: QuarantineReason`, `orphanedIntents?: seq[]` | Awaiting `intent.unquarantine`. |
| `fact.run_requeued_after_crash` | `prevNode?`, `lastAliveAt?` | Startup sweep recovered a run that was `running` when the prior daemon died. The reducer credits `lastAliveAt − dispatchStartedAt` to `activeMs`. |
| `fact.handler_timeout_leaked` | `nodeId`, `leakedAt` | Handler exceeded `maxMs + LEAK_GRACE_MS` (10s) without honoring `ctx.signal`. Handler bug per `docs/handler-contract.md` §4 rule 1. Per-process leak counter advances; daemon shuts down at `LEAK_LIMIT`. |
| `fact.daemon_takeover` | `reclaimedFrom: pid`, `at: ts` | Another daemon reclaimed a stale lock. Expect `fact.run_requeued_after_crash` rows on in-flight runs nearby. |
| `fact.run_branched` | `branch` | Post-terminal: `dispose()` preserved a branch because `git status --porcelain` was non-empty. Lands AFTER the terminal status fact. `swarm gc --branches` joins these against the refspace. |

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
- A node aborted via the `abort` tool → find the `toolCall` block `name:"abort"` in an assistant row; the reason is in `arguments.reason`.
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
- `user` — `UserMessage`. The substituted prompt the node's `prompt = "…"` compiled into. Verify `$ARGUMENTS` resolved (the only substitution token).
- `assistant` — `AssistantMessage`. `content` is `(TextContent | ThinkingContent | ToolCall)[]` in block order. A self-abort is a `ToolCall` block `name:"abort"` with `arguments.reason`.
- `toolResult` — `ToolResultMessage`. Top-level `toolCallId` pairs back to `assistant.ToolCall.id`; `toolName` + `isError` are siblings.

`thread:` on a workflow step shares the transcript across steps that declare the same id (e.g. `implement` + `review` both set `thread: dev` so the reviewer sees the implementer's session). Filter by `node_id` to narrow.

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

- `<nodeId>:stdout` / `<nodeId>:stderr` — `tool` (parallelogram) shell captures, kept for debugging / replay (tool nodes don't feed data forward).

Binary artifacts (mime ≠ text/*) — copy to disk, don't `cat` in-terminal.

**File-then-row commit ordering.** The blob bytes land on disk *before* the `artifacts` row commits — the store hashes content first, writes `<blobsDir>/<sha[0:2]>/<sha>` if missing, and only then runs the `INSERT INTO artifacts (...)` that points at it. Crash diagnosis follows from this ordering:

- Orphan **file** (sha exists on disk, no `artifacts` row referencing it) → daemon crashed between the file write and the row commit. The next `daemon.blob_gc_completed` sweep removes it; harmless.
- Orphan **row** (artifacts row references a sha that doesn't exist on disk) → impossible under correct ordering. If you see one, the blobs directory was tampered with externally.

`MAX_BLOB_BYTES = 16 MiB` is a store-module check, not a SQL `CHECK` constraint. An over-cap insert raises before the file write, so neither the file nor the row lands.

### Provider credentials

Credentials live in the global store (`~/.swarm/swarm.db`, table `provider_credentials`) since the credentials-in-the-store proposal landed. Use it during post-mortems when a run halts with `provider_unavailable` or `paused{reason:"provider_error"}`:

```sh
sqlite3 -readonly ~/.swarm/swarm.db \
  "SELECT provider, kind, updated_at FROM provider_credentials ORDER BY provider;"
```

`kind` is denormalised from `payload.type` so you can spot the shape (`api_key` vs `oauth`) without JSON-parsing. The `payload` blob carries the full credential; **never echo it to logs** — it contains live secrets. `updated_at` jumps on OAuth refresh (last-writer-wins across racers); a stale `updated_at` plus a `paused_auto{reason:"provider_retry"}` run usually means refresh failed.

### Custom-provider definitions

Custom providers (Ollama, vLLM, LM Studio, proxies) and built-in-provider overrides live in `provider_config` on the same store since the follow-up provider-config-storage proposal landed. Use it during post-mortems when a workflow targets a custom provider and the run halts with `model_unresolved` or the registry surfaces a `provider_config: …` warning:

```sh
sqlite3 -readonly ~/.swarm/swarm.db \
  "SELECT provider, length(config), updated_at FROM provider_config ORDER BY provider;"
```

Per-row Ajv failures land on `ModelRegistry.getError()` (surfaced via the `/providers` route's `provider_config_error` field) and don't poison sibling providers — if one row is corrupt the rest still load. The `config` blob is the per-provider definition body (baseUrl, headers, compat, models, modelOverrides); credentials live in `provider_credentials`. There is no `apiKey` field on the blob — `!cmd` / env-var resolution is gone repo-wide.

When a provider row's `models[]` looks wrong, prefer the structured CLI over hand-crafted SQL: `swarm providers ls-models <provider>` prints every entry with `ctx / max / reasoning / cost(in,out)`; `swarm providers edit-model <provider> <id> --<flag> <value>` updates one or more fields while preserving everything else byte-identical; `swarm providers rm-model <provider> <id>` removes a single entry. Each verb Ajv-validates the blob both on read (refuses a structurally-broken row before mutation) and on write, so post-mortem repairs land cleanly without re-walking the whole `add --custom` wizard or hand-crafting `sqlite3 UPDATE provider_config SET config = json_set(...)`.

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
| `fact.run_halted` | `"aborted_exit"` | Codergen agent called the `abort` tool. Pull the assistant turn (§6) — the reason is in the `toolCall` block's `arguments.reason`. |
| `fact.run_halted` | `"max_retries_exceeded"` (Stage 3 — converted) | Backward conditional edge consumed the target's `max_retries`. **Now emits `fact.run_paused{reason:"max_retries"}`** instead of halting. Operator may grant more retries via `intent.max_retries_adjusted`. |
| `fact.run_halted` | `"goal_gate_unsatisfied"` (Stage 3 — converted) | `goal_gate=true` node never settled in SUCCESS/PARTIAL_SUCCESS, retarget chain (SPEC §3.4) exhausted past the failing gate's `max_retries`. **Now emits `fact.run_paused{reason:"goal_gate"}`** instead of halting. |
| `fact.run_halted` | `"abort_loop"` (Stage 3 — converted) | 5 consecutive aborts without progress (`ABORT_LOOP_CEILING`). **Now emits `fact.run_paused{reason:"abort_loop"}`** instead of halting. |
| `fact.run_halted` | `"schema_drift"` | Run's `schema_version` doesn't match daemon's `CURRENT_SCHEMA_VERSION`. Long-paused run across an upgrade. Not auto-recoverable. |
| `fact.run_halted` | `"budget"` | Cumulative cost or tokens hit a declared ceiling — graph-level `budget_usd`/`budget_tokens` or node-level `max_cost_usd`/`max_tokens`. The preceding `budget.warn` event names which ceiling tripped. |
| `fact.run_halted` | `"error"` | Generic handler error. `detail` is a string; cross-reference with `fact.node_aborted { cause:"error" }`. |
| `fact.run_halted` | `"max_loops"` (Stage 3 — converted) | `DEFAULT_MAX_LOOPS = 1000` tripped — workflow looped without aborting and without exhausting `max_retries`. **Now emits `fact.run_paused{reason:"max_loops"}`** instead of halting. |
| `fact.run_halted` | `"occ_exhausted"` | OCC retry budget exhausted on one `(nodeId, iteration)`. Payload: `occContext: { count, nodeId, iteration, lastVersion, attemptedFactType }`. |
| `fact.run_halted` | `"provider_exhausted"` (Stage 3 — converted) | Auto-retry chain capped (5 attempts or 5 cumulative minutes). **Now emits `fact.run_paused{reason:"provider_exhausted"}`** instead of halting. Operator decides via `intent.resume` (start a fresh chain), `intent.cancel`, or steer to a different provider. Walk the chain via `fact.provider_retry_attempted` events. |
| `fact.run_halted` | `"timeout_exhausted"` | Watchdog `maxMs` overrun fired 3 times on the same `(nodeId)` (per-`(nodeId)` counter at `routing.internal.timeout_retries.<nodeId>`). Detail names the node. Each prior watchdog fired a paired `fact.node_aborted{cause:"timeout"}` + `fact.run_paused{reason:"timeout_retry"}` so the chain is reconstructable; the third one halts directly without another pause. Operator action: bump the node's `max_ms` (workflow-level fix) or split the work into smaller nodes. |
| `fact.run_halted` | `"route_not_picked"` | Routing node's codergen turn ended without an isolated `route` tool call (docs/proposals/llm-routing.md D3). Pull the last assistant turn (§6) — the agent likely produced text-only without a tool call, or hit a natural stop before deciding. Tighten the prompt so the model commits to a route, or widen `routes=` if the available branches don't cover what the model wants to express. |
| `fact.run_halted` | `"route_call_not_isolated"` | The `route` tool call shared an assistant response with other tool calls. Re-inspect the offending assistant message (§6); either tighten the prompt so the model commits to the route on its own response, or sequence the side-effect tool calls before the deciding turn. |
| `fact.run_halted` | `"edge_no_match"` | Handler returned a route/outcome and no outgoing edge matched. Validator should make this unreachable for a pinned graph; runtime backstop. Cross-reference the graph (`SELECT pinned_graph FROM run_state WHERE run_id=…`) against the source node's outgoing edges. |
| `fact.run_quarantined` | `"orphan_side_effect"` | Crash left `fact.side_effect_intent` without a matching `_done`/`_failed`. Payload: `orphanedIntents: seq[]`. Resolve via `intent.unquarantine`. |
| `fact.run_cancelled` | — | Operator cancelled. `intentSeq` points to `intent.cancel_requested`. |
| `fact.run_paused_human` | — | `human` node yielded. Payload: `{nodeId, text, routes}`; resume via `/human`. |
| `fact.run_paused` | `reason: "operator"` | Operator hit Pause. Status: `paused`. Wake on `intent.resume`. |
| `fact.run_paused` | `reason: "provider_error"` | Manual-class provider transport error (400/401/403/404/413/422). Status: `paused`. Wake on `intent.resume` after fixing creds/request. |
| `fact.run_paused` | `reason: "payment_required"` | Provider returned 402. Status: `paused`. Top up, then `intent.resume`. |
| `fact.run_paused` | `reason: "budget"` | Local budget cap hit. Status: `paused`. Raise via `POST /runs/:id/budget`, then `intent.resume`. |
| `fact.run_paused` | `reason: "provider_retry"` | Auto-retryable provider transport (408/429/5xx/529/network). Status: `paused_auto`. `resumeAt` on payload + `routing.internal.auto_resume_at`; wake-pending re-queues automatically. Operator may short-circuit with `intent.resume`. |
| `fact.run_paused` | `reason: "handler_retry"` | Node returned `outcome=retry`; engine scheduled a backoff. Status: `paused_auto`. Slot freed during the wait. `routing.internal.auto_resume_at` (ms) tells you when wake-pending will re-queue it. |
| `fact.run_paused` | `reason: "timeout_retry"` | Watchdog `maxMs` overrun. Status: `paused_auto`. Paired with `fact.node_aborted{cause:"timeout"}` for partial-spend metrics. Backoff: 5s on first timeout, doubling to 60s ceiling. Per-`(nodeId)` counter at `routing.internal.timeout_retries.<nodeId>`; cap is 3 → `fact.run_halted{reason:"timeout_exhausted"}`. Operator may short-circuit with `intent.resume`; transcript continuity is preserved (the same `(nodeId, iteration)` re-dispatches with `priorMessages` rehydrated). |
| `fact.run_paused` | `reason: "max_retries"` | Node's retry counter exhausted. Status: `paused`. Naked `intent.resume` grants one more attempt; `intent.max_retries_adjusted{nodeId, newLimit}` raises the per-node cap (writes `routing.max_retries_override.<nodeId>`). |
| `fact.run_paused` | `reason: "goal_gate"` | Goal-gate retarget chain exhausted past the failing gate's `max_retries`. Status: `paused`. `intent.goal_gate_adjusted{newLimit}` raises the cap (writes `routing.max_goal_gate_retries_override`). |
| `fact.run_paused` | `reason: "max_loops"` | Per-run dispatch ceiling exceeded. Status: `paused`. `intent.max_loops_adjusted{newLimit}` raises the cap (writes `routing.max_loops_override`); naked resume re-enters with a fresh JS-local counter at the same effective cap. |
| `fact.run_paused` | `reason: "abort_loop"` | `consecutiveAborts >= abortLoopCeiling` (default 5). Status: `paused`. No per-run knob — ceiling is daemon config. Naked `intent.resume` only. Usually a real bug; resume just to confirm or after fixing the underlying cause. |
| `fact.run_paused` | `reason: "provider_exhausted"` | Provider auto-retry chain capped (5 attempts or 5 cumulative minutes). Status: `paused`. No per-run knob — chain config is daemon-wide. Naked `intent.resume` starts a fresh chain (operator may have fixed the underlying transport issue). |
| `fact.handler_timeout_leaked` | — | Handler exceeded `maxMs + LEAK_GRACE_MS` (10s) without respecting `ctx.signal`. Handler bug. |
| Status `running`, no recent fact | — | Handler may be wedged. If `node_started_at` older than the node's `maxMs`, watchdog should have fired. If not, check daemon heartbeat (§1). |
| Status `paused_auto`, `resumeAt` in the past | — | Wake-pending sweeper hasn't fired. Daemon heartbeat (§1). |

---

## 8.1 Schedule events (daemon_events table)

Schedules are global primitives (proposal: `docs/proposals/scheduled-runs.md`) that fire workflows on a fixed interval. Their audit trail lives in `daemon_events`, not `events` — at the moment of `intent.schedule_create` no run yet exists, and `fact.schedule_skipped` may fire without a corresponding run id. Same 4 KB payload cap, separate AUTOINCREMENT seq space.

```sh
# All schedule activity in the last 24h.
sqlite3 -readonly "$DB" \
  "SELECT seq, type, datetime(ts/1000,'unixepoch','localtime') AS at, run_id, payload
   FROM daemon_events
   WHERE type LIKE 'fact.schedule_%' OR type LIKE 'intent.schedule_%'
   ORDER BY seq DESC LIMIT 50;"

# Trace a single schedule's history.
sqlite3 -readonly "$DB" \
  "SELECT seq, type, run_id, payload
   FROM daemon_events
   WHERE json_extract(payload, '\$.scheduleId') = '<id>'
   ORDER BY seq;"

# Current schedule rows (canonical state — daemon_events is audit-only).
sqlite3 -readonly "$DB" \
  "SELECT id, workflow_ref, cwd, interval_text,
          datetime(next_fire_at/1000,'unixepoch','localtime') AS next,
          datetime(last_fire_at/1000,'unixepoch','localtime') AS last,
          last_run_id, paused_at IS NOT NULL AS paused
   FROM schedules ORDER BY next_fire_at;"
```

| Type | Payload highlights | When you'd read it |
|---|---|---|
| `intent.schedule_create` | `scheduleId`, `workflowRef`, `cwd`, `intervalMs`, `intervalText`, `input?`, `overlapPolicy`, `fireOnCreate` | Audit only — the row in `schedules` is the canonical state. |
| `intent.schedule_pause` / `_resume` / `_delete` | `scheduleId` | Operator action. |
| `fact.schedule_fired` | `scheduleId`, `runId` | Tick produced a run; join against `run_state.schedule_id`. |
| `fact.schedule_skipped` | `scheduleId`, `reason: "overlap" \| "paused"` | Tick fired but didn't enqueue. `overlap` → previous run still active under `overlap_policy="skip"`. |
| `fact.schedule_late` | `scheduleId`, `missedIntervals`, `lastTargetAt` | Catch-up: ≥1 whole interval between `lastTargetAt` and `now`. Emitted *before* the catch-up fire. Daemon was down or under load. |
| `fact.schedule_invalid_workflow` | `scheduleId`, `error` | `workflowRef` no longer resolves (workflow file deleted/renamed). The schedule keeps trying — fix the ref or delete the schedule. |

`run_state.schedule_id` is the lineage key — every fired run carries the schedule it came from. `LEFT JOIN schedules ON run_state.schedule_id = schedules.id` to filter the run feed by schedule.

---

## 8.2 Subagent post-mortem

Sub-agents (the `agent` tool) have no `run_state` row and no separate event stream. Every event the sub-agent emits rides the **parent's** event stream with `subagent_id` on the payload as a discriminator. Three observability events bracket each spawn:

- `subagent.start { subagent_id, parent_node_id, iteration, model, provider, name?, agent_def?, tool_call_id?, args_hash? }`
- `subagent.end { subagent_id, status, summary_chars, total_tool_calls, costUsd, totalTokens, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, halt_reason? }`
- `subagent.resumed { subagent_id, reason: "already_completed" | "transcript_hydrated" }` — fires on either a daemon-crash respawn (proposal: `docs/proposals/sub-agent-crash-resilience.md`) OR a content-addressed FIFO pop (see below).

`subagent_id` is picked at spawn time via two paths:

1. **Content-addressed FIFO queue (default when `subagent.start.args_hash` is present).** A cancelled sub-agent enters a queue keyed by `(parent_run, parent_node_id, iteration, args_hash)` where `args_hash` is sha256 over the spec's canonical args (prompt, system_prompt, allowed_tools, disallowed_tools, skills, max_iterations, agent_def, model, provider). The NEXT spawn with matching args pops the oldest pending entry (oldest = lowest seq), reuses its `subagent_id`, and emits `subagent.resumed{reason:"transcript_hydrated"}` to consume it. Lets a parent retry that uses byte-identical agent-tool args automatically resume the sub-agent's work-so-far across a budget pause / provider error / operator pause — no `resume_subagent_id` parameter, no LLM cooperation. "Pending" = latest terminal is `subagent.end{status:"cancelled"}` AND no subsequent `subagent.resumed` for the id. To audit which brackets are still pending for a run:
   ```sh
   sqlite3 -readonly "$DB" "
     SELECT json_extract(s.payload, '\$.subagent_id'),
            json_extract(s.payload, '\$.args_hash'),
            json_extract(s.payload, '\$.parent_node_id')
     FROM events s
     WHERE s.run_id='$RUN' AND s.type='subagent.start'
       AND EXISTS (SELECT 1 FROM events e WHERE e.run_id=s.run_id AND e.type='subagent.end'
                    AND json_extract(e.payload,'\$.subagent_id')=json_extract(s.payload,'\$.subagent_id')
                    AND json_extract(e.payload,'\$.status')='cancelled')
       AND NOT EXISTS (SELECT 1 FROM events r WHERE r.run_id=s.run_id AND r.type='subagent.resumed'
                       AND json_extract(r.payload,'\$.subagent_id')=json_extract(s.payload,'\$.subagent_id'));
   "
   ```

2. **Fresh deterministic id (fallback).** `sha256(parentRunId, parentNodeId, parentIteration, tool_call_id)` truncated to 32 hex chars. Survives a daemon crash because pi-ai preserves `tool_call_id` byte-identically on the wire. Used when `args_hash` isn't set (older spawns, hand-rolled test events) or when no pending-resume candidate matches.

```sh
# Bracket events for one parent run, ordered.
sqlite3 -readonly "$DB" \
  "SELECT seq, type, datetime(ts/1000,'unixepoch','localtime') AS at, payload
   FROM events WHERE run_id='$RUN' AND type LIKE 'subagent.%' ORDER BY seq;"

# All events emitted by one specific sub-agent (start, end, plus everything the child emitted in between).
sqlite3 -readonly "$DB" \
  "SELECT seq, type, payload FROM events
   WHERE run_id='$RUN'
     AND json_extract(payload, '\$.subagent_id') = '<subagent_id>'
   ORDER BY seq;"

# Sub-agent transcript (parent + all children share the messages table; children sit under the __subagent:<id> namespace).
sqlite3 -readonly "$DB" \
  "SELECT ordinal, role, node_id, length(content) AS bytes
   FROM messages WHERE run_id='$RUN' AND node_id LIKE '__subagent:%'
   ORDER BY ordinal;"
```

The bidirectional handle the parent LLM sees back is the `agent` tool's result: `{ subagent_id, status, total_tool_calls, halt_reason? }`. UIs prefer `subagent.start.name` (caller-supplied label from `agent({ name: <label> })`) when present; fall back to `agent_def` (the resolved profile name from `agent({ agent: <def-name> })` matched against `.agents/agents/`).

**Cost accounting trap.** `subagent.end.costUsd` and the token fields are **cumulative across every spawn of the same `subagent_id`** (the daemon seeds the rollup from prior `subagent.end` rows for that id when respawning). Consumers summing across a run's `subagent.end` rows MUST dedupe by `subagent_id` and take the terminal (non-cancelled) bracket — naive summation over-counts on resumed brackets. The parent's `total_cost_usd` projection is unaffected; it folds each `fact.node_completed.costUsd` once.

---

## 9. Known-incomplete

Per `docs/ARCHITECTURE.md` §12.1, these surfaces parse/serialize but aren't wired:

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
  "SELECT run_id, status, current_node, version, workflow_sha,
          schedule_id, cwd, routing, metrics,
          datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM run_state WHERE run_id='$RUN';"

# Terminal facts first
sqlite3 -readonly "$DB" \
  "SELECT seq, type, payload FROM events WHERE run_id='$RUN'
   AND type IN ('fact.run_completed','fact.run_halted','fact.run_cancelled',
                'fact.run_quarantined','fact.run_paused_human',
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

# Schedule activity (separate seq space; see §8.1)
sqlite3 -readonly "$DB" \
  "SELECT seq, type, run_id, datetime(ts/1000,'unixepoch','localtime') AS at, payload
   FROM daemon_events
   WHERE type LIKE 'fact.schedule_%' OR type LIKE 'intent.schedule_%'
   ORDER BY seq DESC LIMIT 20;"

# Subagent brackets for one parent run (§8.2)
sqlite3 -readonly "$DB" \
  "SELECT seq, type, payload FROM events
   WHERE run_id='$RUN' AND type LIKE 'subagent.%' ORDER BY seq;"
```

Intent writes (steer/pause/cancel/human/unquarantine/priority) change state — they're not debugging tools. Present evidence; let the user decide whether to write one.
