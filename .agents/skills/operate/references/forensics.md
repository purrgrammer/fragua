# forensics — run post-mortem reference

Forensics reference for the `operate` skill: go from a run id to a one-paragraph cause with evidence (event seq + payload). Loaded on demand when diagnosing a failed or stuck run. All `fragua` CLI; SQLite only for the two verb-less reads below (schedule audit trail, raw credential rows).

Authoritative references: [`docs/SPEC.md`](../../../../docs/SPEC.md) §3 (primitives + lifecycle), [`docs/ARCHITECTURE.md`](../../../../docs/ARCHITECTURE.md) §2 (schema) + §3 (event taxonomy), [`docs/handler-contract.md`](../../../../docs/handler-contract.md) (handler replay semantics).

The goal is the same as operate's: go from a run id to a cause in the fewest reads. Read `runs status` and the ending first; only `--json` into steps / messages / events when the summary is inconclusive.

---

## Fast path

```sh
RUN=<run-id>                          # the full id (resolve via `runs ls`, §2)

fragua runs status "$RUN"             # lifecycle + outcome + the why
fragua runs events "$RUN" --type fact.run_    # terminal facts — the ending
```

`fragua runs status` gives you status, workflow, cost/tokens, duration, and the *why*: pause reason + fields, halt reason + detail, quarantine `orphanedIntents`, or the HITL gate. For `completed` / `cancelled` runs the story is short. For everything else, read the ending (§3) and then walk the timeline (§4).

`fragua doctor` first if the symptom is "nothing is moving" — it tells you whether a daemon is even alive (§1).

---

## 1. Locate the instance

One SQLite store is the coordination surface; the daemon + HTTP server poll it. `fragua doctor` prints the whole picture in one shot:

```sh
fragua doctor                 # default store ~/.fragua/fragua.db
fragua doctor --db <path>     # CI primitive / a non-default instance
```

`doctor` prints:

- **store path** — which DB you're actually on. Always note it; parallel fraguas (different `--db`) coexist.
- **daemon** — pid + heartbeat age. Fresh (~30s window, `DEFAULT_LOCK_TTL_MS = 30_000` in `packages/daemon/src/entrypoint.ts`) reads "alive"; older reads "stale" — `running` runs may be orphaned until the next daemon start sweeps them. No daemon at all reads "no daemon (runs sit queued)".
- **server endpoint** — the HTTP/SSE bind, if a server is up. Operator forensics don't use it; it's informational.
- **provider summary** — credentialed providers at a glance.

A stale or absent daemon is the usual root cause of "stuck" runs: `queued` runs never dispatch, and `running` runs sit orphaned until a daemon reclaims the lock.

---

## 2. Resolve the run id

Run ids are long; users paste prefixes or descriptions. There is no prefix-resolve verb — list and pick the full id.

```sh
fragua runs ls                         # one line per run: id · status · title
fragua runs ls --status halted,paused  # narrow by lifecycle status
fragua runs ls --limit 50              # widen the window
```

Find the row, copy the full id. Multiple plausible matches → show the user, ask which. Nothing matches → confirm you're on the right store (`fragua doctor` prints the path; pass `--db` if it's a non-default instance).

---

## 3. Read the ending first

Every run has a terminal fact or a suspensive state. `fragua runs status` usually names it directly. To see the terminal fact rows with payloads:

```sh
fragua runs events "$RUN" --type fact.run_      # run_completed/halted/cancelled/quarantined/paused*
fragua runs events "$RUN" --type fact.          # all facts (node_aborted, side_effect_failed, …)
```

The last `fact.run_*` almost always names the cause. Cross-reference with the **Failure-mode playbook** (§8). For the mid-flight facts (`fact.node_aborted`, `fact.handler_timeout_leaked`, `fact.side_effect_failed`) widen to `--type fact.`.

---

## 4. Walk the event timeline

If the ending is ambiguous (`fact.run_halted { reason: "error" }` with no detail) or you need the *why* behind the *what*:

```sh
fragua runs events "$RUN"                       # full timeline, newest-relevant tail
fragua runs events "$RUN" --type fact.          # facts only
fragua runs events "$RUN" --type intent.        # operator intents only
fragua runs events "$RUN" --limit 100           # cap the window — events run to thousands on long runs
fragua runs events "$RUN" --json                # raw payloads (the field references below live here)
```

What to look for:

- **Intent writes** (`intent.*`) preceding an abort — e.g. `intent.pause_requested` just before `fact.node_aborted { cause:"pause" }` explains the pause cleanly. `--type intent.` isolates them.
- **`fact.node_aborted { cause }`** — `"steer" | "pause" | "cancel" | "timeout" | "shutdown" | "abort_loop" | "error"`. Steer aborts pair with a prior `intent.steering_requested`; timeouts don't.
- **Repeated `fact.node_started { iteration: N }` on the same node** — loop through backward conditional edges. Hit on `max_retries` → `fact.run_paused { reason: "max_retries" }` (operator-resumable; raise via `fragua runs max-retries`).
- **`fact.side_effect_intent` without a matching `_done`/`_failed`** by `idempotencyKey` — crash between the two quarantines on next daemon start. Orphan-side-effect invariant (ARCHITECTURE §1.1).
- **`fact.handler_timeout_leaked`** — executor hard-timed-out a handler that ignored `ctx.signal`. Handler bug (`docs/handler-contract.md` §4 rule 1).
- **`fact.daemon_takeover`** — another daemon reclaimed a stale lock. Expect `fact.run_requeued_after_crash` nearby on in-flight runs.
- **`agent.info { event: "thread_rehydrated", thread_id, message_count }`** — a codergen node picked up a `thread_id` with prior messages from a previous backend instance. Fidelity is invariant; the Agent's `initialState.messages` is seeded byte-identical. Informational. If you see this during a "why did my run skip context?" investigation, the answer is it didn't.
- **`run_state.routing` keys worth a glance** (surfaced on `fragua runs status`, or in the `--json` payloads):
  - `goal_gates.<nodeId>` — last outcome of every visited gate.
  - `goal_gates.__retries` — cumulative retarget count. Reaches the failing gate's `max_retries` → `fact.run_paused { reason: "goal_gate" }` (operator-resumable; raise via `fragua runs goal-gate`).
  - `internal.auto_resume_at` — wall-clock ms when a `paused_auto` run (reason `provider_retry` or `handler_retry`) is due to wake (one routing key powers both reasons; canonical declaration: `packages/core/src/types/context.ts` `AUTO_RESUME_AT_KEY`). In the past + still paused → wake-pending sweeper is wedged (check daemon heartbeat via `fragua doctor`).
  - `__budget_warned.*` — tags suppressing duplicate `budget.warn` events.

Observability events outside fact/intent (`llm.start`, `llm.text_delta`, `llm.done`, `cost.recorded`, `summary.*`, `agent.info`, `agent.warning`) carry `nodeId` + `iteration` and fold into step snapshots — don't read them raw, use §5.

### 4.1 Fact-event quick reference

Authoritative source: `FactEvent` union in `packages/types/src/fragua-events.ts`. The §8 playbook covers terminal / blocking facts in detail; this table covers the *informational* facts you'll see walking the timeline (`fragua runs events "$RUN" --json` shows the payload fields).

| Fact type | Payload highlights | When you'd read it |
|---|---|---|
| `fact.dispatch_started` | `nodeId`, `iteration` | Marks the boundary where an executor pass picked up the run; `dispatch_started_at` on `run_state` syncs from this. Useful for active-time accounting. |
| `fact.node_started` | `nodeId`, `iteration` | Node entered. Repeated rows on the same `(nodeId, iteration)` indicate a backward conditional edge looping; cap is the node's `max_retries`. |
| `fact.node_completed` | `nodeId`, `iteration`, `outcomeStatus?`, `tokens`, `costUsd` + 4-bucket splits, `nextNode`, `outputRef?` | Node finished. `outcomeStatus="fail"` here matches against `condition="outcome=fail"` edges; the run can still continue. |
| `fact.node_aborted` | `nodeId`, `iteration`, `cause`, `partial*` | Mid-flight abort. `cause`: `steer \| pause \| cancel \| timeout \| shutdown \| abort_loop \| error`. |
| `fact.intents_folded` | `intentSeq`, `folded` | Intent fold landed. Useful when the timeline shows a steer/pause/human that didn't visibly change behaviour — read `folded` to see what the fold did. |
| `fact.message_appended` | `ordinal`, `role`, `nodeId\|null`, `iteration` | Message metadata. Don't read these raw; use `fragua runs messages` (§6). |
| `fact.tool_completed` | `toolName`, `argsHash`, `artifactKey`, `preview`, `summary?` | Non-external tool result (skill-tool, agent-tool, read/edit/bash). The artifact at `artifactKey` carries the body (§7). |
| `fact.side_effect_intent` | `nodeId`, `iteration`, `toolName`, `argsHash`, `attempt`, `idempotencyKey` | External tool dispatched. Followed by exactly one `_done` or `_failed`; missing pair → orphan-side-effect quarantine on next daemon start. |
| `fact.side_effect_done` | `idempotencyKey`, `artifactKey`, `tokens?`, `costUsd?` | External tool completed. Pair with the matching `_intent` row by `idempotencyKey`. |
| `fact.side_effect_failed` | `idempotencyKey`, `errorCode`, `retriable: bool` | External tool failed cleanly. `retriable=true` → handler will redrive; `false` → permanent. |
| `fact.run_paused_human` | `nodeId`, `text`, `routes` | Human node yield. See §8 playbook. |
| `fact.run_paused` | `reason`, reason-specific fields | Unified pause. Reasons in `AUTO_WAKE_PAUSE_REASONS` (`provider_retry`, `handler_retry`) project to `paused_auto`; rest → `paused`. See §8. |
| `fact.provider_retry_attempted` | `nodeId`, `attempt`, `httpStatus\|null`, `delayMs` | One per attempt in an auto-retry chain. Walk these to reconstruct the retry timeline before a `provider_exhausted` pause. |
| `fact.run_resumed` | `fromStatus: RunStatus`, `inputIntentSeq?` | Run left a paused/quarantined state. `inputIntentSeq` points back at the operator intent that drove the wake (when applicable). |
| `fact.run_completed` | `finalNode` | Terminal success. |
| `fact.run_halted` | `reason: HaltReason`, `detail?`, `occContext?` | Terminal failure. See §8. |
| `fact.run_cancelled` | `intentSeq` | Operator cancelled. `intentSeq` resolves the originating `intent.cancel_requested`. |
| `fact.run_quarantined` | `reason: QuarantineReason`, `orphanedIntents?: seq[]` | Awaiting `fragua runs unquarantine`. |
| `fact.run_requeued_after_crash` | `prevNode?`, `lastAliveAt?` | Startup sweep recovered a run that was `running` when the prior daemon died. The reducer credits `lastAliveAt − dispatchStartedAt` to `activeMs`. |
| `fact.handler_timeout_leaked` | `nodeId`, `leakedAt` | Handler exceeded `maxMs + LEAK_GRACE_MS` (30s) without honoring `ctx.signal`. Handler bug per `docs/handler-contract.md` §4 rule 1. Per-process leak counter advances; daemon shuts down at `LEAK_LIMIT`. |
| `fact.daemon_takeover` | `reclaimedFrom: pid`, `at: ts` | Another daemon reclaimed a stale lock. Expect `fact.run_requeued_after_crash` rows on in-flight runs nearby. |
| `fact.run_discarded` | `refs[]` | Operator (`fragua runs discard`): deleted the run's `refs/fragua/{snapshots,heads}/<id>`. Inbox `pending → discarded`. Now in `FEED_EVENT_KINDS`. |
| `fact.snapshot_recorded` | `eventIdx`, `treeSha`, `commitSha`, `parentSnap`, `headSha`, `headRef`, `diffBaseSha`, `committed`, `uncommitted` | Terminal worktree snapshot (worktrees.md). Once per worktree-backed run, after the terminal status fact; projects `change_stat` / `inbox_status` / `final_*`. Per-step + HITL snapshots are the `snapshot.captured` observability event (no fact). |

---

## 5. LLM step snapshots

`fragua runs steps` folds `llm.start` + `llm.text_delta` + `llm.done` + `cost.recorded` into one `StepSnapshot` per call. Richest per-call artifact: resolved prompt, system prompt, allowed tools, settings, model, tokens, cost, duration.

```sh
fragua runs steps "$RUN"              # one line per call: stepIdx · nodeId · iteration · model · duration · tokens · cost
fragua runs steps "$RUN" --json       # resolved prompts + system prompt + full snapshot
```

Reach for `--json` only when the per-line summary is inconclusive — e.g. you suspect a prompt-substitution or context-assembly problem and need the resolved prompt text.

---

## 6. Read the messages transcript

`messages.content` stores pi-agent-core `AgentMessage` JSON (§I9) — same shape pi-ai accepts as `priorMessages`. Block structure round-trips losslessly: text, thinking (`thinkingSignature` + optional `redacted`), toolCall (`thoughtSignature` on Gemini), toolResult (paired by `toolCallId`), plus fragua's `SystemPromptMessage` custom type (`role:"system"`).

Reach for the transcript when:

- A codergen node produced wrong output → read its `content[]` blocks.
- A node aborted via the `abort` tool → find the `toolCall` block `name:"abort"` in an assistant row; the reason is in `arguments.reason`.
- A prompt template failed to substitute (`${{ inputs.foo }}` appeared literally) → visible on `role:"user"` rows.
- Context management is suspect → read the `role:"system"` row for the assembled prompt.
- Tool-call pairing — `assistant.content[i]` `toolCall { id, name, arguments }` pairs with the next `role:"toolResult"` row whose `toolCallId` matches.

```sh
fragua runs messages "$RUN"                 # preview lines: ordinal · role · nodeId · iteration
fragua runs messages "$RUN" --node plan     # narrow to one node
fragua runs messages "$RUN" --json          # full AgentMessage content blocks
```

The default is preview-only. Reach for `--json` sparingly — only once the previews point at the row that proves the hypothesis.

Roles, in brief:

- `system` — `SystemPromptMessage { role, content, timestamp }`. Per-call assembled system prompt; written by the agent backend to keep `llm.start` under the 4KB event cap. Filtered out before pi-ai (which carries the system prompt separately).
- `user` — `UserMessage`. The substituted prompt the node's `prompt = "…"` compiled into. Verify `${{ inputs.<name> }}` resolved (the only substitution token).
- `assistant` — `AssistantMessage`. `content` is `(TextContent | ThinkingContent | ToolCall)[]` in block order. A self-abort is a `ToolCall` block `name:"abort"` with `arguments.reason`.
- `toolResult` — `ToolResultMessage`. Top-level `toolCallId` pairs back to `assistant.ToolCall.id`; `toolName` + `isError` are siblings.

`thread:` on a workflow step shares the transcript across steps that declare the same id (e.g. `implement` + `review` both set `thread: dev` so the reviewer sees the implementer's session). `--node` narrows.

The transcript populates at every `message_end`, so it reflects live state — not just terminal runs.

---

## 7. Inspect artifacts

Per-`(run, node, iteration, key)` content referenced by sha256 blobs — raw stdout/stderr, node outputs, anything over the 4KB event cap.

```sh
fragua runs artifacts "$RUN"        # list: nodeId#iteration  key  mime  sizeB
fragua runs artifact "$RUN" <nodeId> --key <key> [--iteration N]   # dump one blob's body
```

`fragua runs artifact` refuses to dump a binary body (mime ≠ text/*) to a TTY — redirect to a file if you genuinely need the bytes.

Conventional keys:

- `<nodeId>:stdout` / `<nodeId>:stderr` — `type: tool` shell captures, kept for debugging / replay (tool nodes don't feed data forward).

**File-then-row commit ordering.** The blob bytes land on disk *before* the `artifacts` row commits — the store hashes content first, writes the blob file if missing, and only then runs the `INSERT INTO artifacts (...)` that points at it. Crash diagnosis follows from this ordering:

- Orphan **file** (sha exists on disk, no `artifacts` row referencing it) → daemon crashed between the file write and the row commit. The next `daemon.blob_gc_completed` sweep removes it; harmless.
- Orphan **row** (artifacts row references a sha that doesn't exist on disk) → impossible under correct ordering. If you see one, the blobs directory was tampered with externally.

`MAX_BLOB_BYTES = 16 MiB` is a store-module check, not a SQL `CHECK` constraint. An over-cap insert raises before the file write, so neither the file nor the row lands.

### Worktree changes

For "what did the run actually change in the working tree?":

```sh
fragua runs diff "$RUN"             # base..tip diff; survives worktree disposal via the preserved branch
```

It sits on top of the run's `.fragua/worktrees/<run_id>/` directory and the preserved `refs/fragua/heads/<run_id>` branch.

### Provider config + credentials

When a run halts with `provider_unavailable` / `model_unresolved` or pauses with `reason:"provider_error"`, check the provider surface:

```sh
fragua providers ls                       # configured providers; ✓ = credentialed (presence, not the secret)
fragua providers ls-models <provider>     # every model entry with ctx / max / reasoning / cost(in,out)
```

`fragua providers ls-models` prints the per-provider model definitions (Ajv-validated on read; a structurally-broken row is refused before it can poison siblings). When a `model:` in a workflow doesn't resolve, this is where you confirm whether the entry exists and whether its fields are sane. Raw credential rows are a verb-less read — see the escape hatch below.

---

## 8. Failure-mode playbook

The "resolve via" / "raise via" actions are operator intents — write them with the matching `fragua runs <verb>` (these are the operate skill's control plane). Field references in payloads are what `fragua runs events --json` shows.

| Terminal fact | `reason` / cause | What it means |
|---|---|---|
| `fact.run_halted` | `"aborted_exit"` | Codergen agent called the `abort` tool. Pull the assistant turn (§6) — the reason is in the `toolCall` block's `arguments.reason`. |
| `fact.run_paused` | `reason: "max_retries"` (converted) | Backward conditional edge consumed the target's `max_retries`. Emits `fact.run_paused{reason:"max_retries"}` (operator-resumable). Grant more via `fragua runs max-retries`, then `fragua runs resume`. |
| `fact.run_paused` | `reason: "goal_gate"` (converted) | `goal_gate=true` node never settled in SUCCESS/PARTIAL_SUCCESS; retarget chain (SPEC §3.4) exhausted past the failing gate's `max_retries`. Emits `fact.run_paused{reason:"goal_gate"}`. Raise via `fragua runs goal-gate`, then `resume`. |
| `fact.run_paused` | `reason: "abort_loop"` (converted) | 5 consecutive aborts without progress (`ABORT_LOOP_CEILING`). Emits `fact.run_paused{reason:"abort_loop"}`. No per-run knob; naked `fragua runs resume` only. |
| `fact.run_paused` | `reason: "engine_incompatible"` | Run's pinned `schema_version` falls outside this daemon's `[supportedMin, supportedMax]` fold window. `pinnedVersion > supportedMax` (too new — downgraded binary or newer-producer import) heals once a capable daemon runs; `pinnedVersion < supportedMin` (too old) needs an operator rebuild or `fragua runs cancel`. Both project to `paused` — operator-resumable, not a terminal halt. |
| `fact.run_halted` | `"budget"` | Cumulative cost or tokens hit a declared ceiling — graph-level `budget_usd`/`budget_tokens` or node-level `max_cost_usd`/`max_tokens`. The preceding `budget.warn` event names which ceiling tripped. |
| `fact.run_halted` | `"error"` | Generic handler error. `detail` is a string; cross-reference with `fact.node_aborted { cause:"error" }`. |
| `fact.run_paused` | `reason: "max_loops"` (converted) | `DEFAULT_MAX_LOOPS = 1000` tripped — workflow looped without aborting and without exhausting `max_retries`. Emits `fact.run_paused{reason:"max_loops"}`. Raise via `fragua runs max-loops`, then `resume`. |
| `fact.run_halted` | `"occ_exhausted"` | OCC retry budget exhausted on one `(nodeId, iteration)`. Payload: `occContext: { count, nodeId, iteration, lastVersion, attemptedFactType }`. |
| `fact.run_paused` | `reason: "provider_exhausted"` (converted) | Auto-retry chain capped (5 attempts or 5 cumulative minutes). Emits `fact.run_paused{reason:"provider_exhausted"}`. Operator decides via `fragua runs resume` (start a fresh chain), `fragua runs cancel`, or steer to a different provider. Walk the chain via `fact.provider_retry_attempted` events. |
| `fact.run_halted` | `"timeout_exhausted"` | Watchdog `maxMs` overrun fired 3 times on the same `(nodeId)` (per-`(nodeId)` counter at `routing.internal.timeout_retries.<nodeId>`). Detail names the node. Each prior watchdog fired a paired `fact.node_aborted{cause:"timeout"}` + `fact.run_paused{reason:"timeout_retry"}` so the chain is reconstructable; the third one halts directly without another pause. Operator action: bump the node's `max_ms` (workflow-level fix) or split the work into smaller nodes. |
| `fact.run_halted` | `"route_not_picked"` | Routing node's codergen turn ended without an isolated `route` tool call. Pull the last assistant turn (§6) — the agent likely produced text-only without a tool call, or hit a natural stop before deciding. Tighten the prompt so the model commits to a route, or widen `routes=` if the available branches don't cover what the model wants to express. |
| `fact.run_halted` | `"route_call_not_isolated"` | The `route` tool call shared an assistant response with other tool calls. Re-inspect the offending assistant message (§6); either tighten the prompt so the model commits to the route on its own response, or sequence the side-effect tool calls before the deciding turn. |
| `fact.run_halted` | `"edge_no_match"` | Handler returned a route/outcome and no outgoing edge matched. Validator should make this unreachable for a pinned graph; runtime backstop. Cross-reference the pinned graph against the source node's outgoing edges (`fragua runs status` names the node). |
| `fact.run_quarantined` | `"orphan_side_effect"` | Crash left `fact.side_effect_intent` without a matching `_done`/`_failed`. Payload: `orphanedIntents: seq[]`. Resolve via `fragua runs unquarantine`. |
| `fact.run_cancelled` | — | Operator cancelled. `intentSeq` points to `intent.cancel_requested`. |
| `fact.run_paused_human` | — | `human` node yielded. Payload: `{nodeId, text, routes}`; resume via `fragua runs respond`. |
| `fact.run_paused` | `reason: "operator"` | Operator hit Pause. Status: `paused`. Wake on `fragua runs resume`. |
| `fact.run_paused` | `reason: "provider_error"` | Manual-class provider transport error (400/401/403/404/413/422). Status: `paused`. Wake on `fragua runs resume` after fixing creds/request. |
| `fact.run_paused` | `reason: "payment_required"` | Provider returned 402. Status: `paused`. Top up, then `fragua runs resume`. |
| `fact.run_paused` | `reason: "budget"` | Local budget cap hit. Status: `paused`. Raise via `fragua runs budget`, then `fragua runs resume`. |
| `fact.run_paused` | `reason: "provider_retry"` | Auto-retryable provider transport (408/429/5xx/529/network). Status: `paused_auto`. `resumeAt` on payload + `routing.internal.auto_resume_at`; wake-pending re-queues automatically. Operator may short-circuit with `fragua runs resume`. |
| `fact.run_paused` | `reason: "handler_retry"` | Node returned `outcome=retry`; engine scheduled a backoff. Status: `paused_auto`. Slot freed during the wait. `routing.internal.auto_resume_at` (ms) tells you when wake-pending will re-queue it. |
| `fact.run_paused` | `reason: "timeout_retry"` | Watchdog `maxMs` overrun. Status: `paused_auto`. Paired with `fact.node_aborted{cause:"timeout"}` for partial-spend metrics. Backoff: 5s on first timeout, doubling to 60s ceiling. Per-`(nodeId)` counter at `routing.internal.timeout_retries.<nodeId>`; cap is 3 → `fact.run_halted{reason:"timeout_exhausted"}`. Operator may short-circuit with `fragua runs resume`; transcript continuity is preserved (the same `(nodeId, iteration)` re-dispatches with `priorMessages` rehydrated). |
| `fact.run_paused` | `reason: "max_retries"` | Node's retry counter exhausted. Status: `paused`. Naked `fragua runs resume` grants one more attempt; `fragua runs max-retries <id> <n> --node <nodeId>` raises the per-node cap (writes `routing.max_retries_override.<nodeId>`). |
| `fact.run_paused` | `reason: "goal_gate"` | Goal-gate retarget chain exhausted past the failing gate's `max_retries`. Status: `paused`. `fragua runs goal-gate <id> <n>` raises the cap (writes `routing.max_goal_gate_retries_override`), then `resume`. |
| `fact.run_paused` | `reason: "max_loops"` | Per-run dispatch ceiling exceeded. Status: `paused`. `fragua runs max-loops <id> <n>` raises the cap (writes `routing.max_loops_override`); naked `resume` re-enters with a fresh JS-local counter at the same effective cap. |
| `fact.run_paused` | `reason: "abort_loop"` | `consecutiveAborts >= abortLoopCeiling` (default 5). Status: `paused`. No per-run knob — ceiling is daemon config. Naked `fragua runs resume` only. Usually a real bug; resume just to confirm or after fixing the underlying cause. |
| `fact.run_paused` | `reason: "provider_exhausted"` | Provider auto-retry chain capped (5 attempts or 5 cumulative minutes). Status: `paused`. No per-run knob — chain config is daemon-wide. Naked `fragua runs resume` starts a fresh chain (operator may have fixed the underlying transport issue). |
| `fact.handler_timeout_leaked` | — | Handler exceeded `maxMs + LEAK_GRACE_MS` (30s) without respecting `ctx.signal`. Handler bug. |
| Status `running`, no recent fact | — | Handler may be wedged. If `node_started_at` older than the node's `maxMs`, watchdog should have fired. If not, check daemon heartbeat (`fragua doctor`, §1). |
| Status `paused_auto`, `resumeAt` in the past | — | Wake-pending sweeper hasn't fired. Daemon heartbeat (`fragua doctor`, §1). |

---

## 8.1 Schedule events

Schedules are global primitives that fire workflows on a fixed interval. `fragua schedule list` shows the **current** schedule rows (canonical state) — id, workflow ref, cwd, interval, next/last fire, last run id, paused flag:

```sh
fragua schedule list [--cwd <dir>]
```

The schedule **audit trail** (the history of `fact.schedule_*` / `intent.schedule_*` events) lives in `daemon_events`, not in any CLI verb — see the escape hatch below. The events themselves:

| Type | Payload highlights | When you'd read it |
|---|---|---|
| `intent.schedule_create` | `scheduleId`, `workflowRef`, `cwd`, `intervalMs`, `intervalText`, `input?`, `overlapPolicy`, `fireOnCreate` | Audit only — the row in `schedule list` is the canonical state. |
| `intent.schedule_pause` / `_resume` / `_delete` | `scheduleId` | Operator action. |
| `fact.schedule_fired` | `scheduleId`, `runId` | Tick produced a run; the run carries `schedule_id` lineage. |
| `fact.schedule_skipped` | `scheduleId`, `reason: "overlap" \| "paused"` | Tick fired but didn't enqueue. `overlap` → previous run still active under `overlap_policy="skip"`. |
| `fact.schedule_late` | `scheduleId`, `missedIntervals`, `lastTargetAt` | Catch-up: ≥1 whole interval between `lastTargetAt` and `now`. Emitted *before* the catch-up fire. Daemon was down or under load. |
| `fact.schedule_invalid_workflow` | `scheduleId`, `error` | `workflowRef` no longer resolves (workflow file deleted/renamed). The schedule auto-pauses; fix the ref and `fragua schedule resume`, or `fragua schedule rm`. |

`run_state.schedule_id` is the lineage key — every fired run carries the schedule it came from, so a fired run's `fragua runs status` / `fragua runs events` are reachable the normal way once you have its id from `schedule list` (`last_run_id`) or the `fact.schedule_fired` audit row.

---

## Escape hatch (no CLI verb yet)

Two reads have no `fragua` verb. Use `sqlite3 -readonly` against the store (`fragua doctor` prints the path; default `~/.fragua/fragua.db`). Everything else is a CLI verb above.

**1. Schedule audit trail** — `schedule list` shows current rows, not the history. The `fact.schedule_*` / `intent.schedule_*` events live in `daemon_events` (separate AUTOINCREMENT seq space from `events`; same 4 KB payload cap):

```sh
DB=~/.fragua/fragua.db                          # `fragua doctor` prints the actual path

# All schedule activity, recent first.
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
```

**2. Raw `provider_credentials` rows** — `fragua providers ls` shows presence (✓), not the row body. To inspect shape/freshness:

```sh
sqlite3 -readonly "$DB" \
  "SELECT provider, kind, datetime(updated_at/1000,'unixepoch','localtime') AS updated
   FROM provider_credentials ORDER BY provider;"
```

`kind` is denormalised from `payload.type` so you can spot the shape (`api_key` vs `oauth`) without JSON-parsing. **Never echo the `payload` column** — it carries live secrets. `updated_at` jumps on OAuth refresh (last-writer-wins across racers); a stale `updated_at` plus a `paused_auto{reason:"provider_retry"}` run usually means refresh failed.

---

## Known-incomplete

Per `docs/ARCHITECTURE.md` §12.1, these surfaces parse/serialize but aren't wired:

- **Per-node provider preflight.** Enqueue checks that *some* provider key is configured, not the specific provider on each node. A workflow hardcoding an unconfigured provider fails at *dispatch* with `fact.run_halted`, not at enqueue.

When something looks broken, check §12.1 first.

---

## Anti-patterns

- **Don't guess from status alone.** `halted` needs the fact payload (`fragua runs status`, or `fragua runs events --type fact.run_`); `running` needs heartbeat (`fragua doctor`) + `node_started_at`.
- **Don't dump full transcripts.** `fragua runs messages` is preview-only by default; reach for `--json` sparingly — only once a preview points at the row that proves the hypothesis.
- **Don't unquarantine on the user's behalf.** `fragua runs unquarantine` is a decision with external-world consequences — present evidence, let the user pick.
- **Don't assume one daemon.** Parallel fraguas (different `--db`) coexist. `fragua doctor` prints the store path so the user can verify which instance you're on; pass `--db` to target another.

---

## Cheat sheet

```sh
RUN=<run-id>

fragua doctor                               # store path + daemon heartbeat + server + providers
fragua runs ls [--status …] [--limit N]     # find / resolve a run (copy the full id)

fragua runs status "$RUN"                   # lifecycle + outcome + the why
fragua runs events "$RUN" --type fact.run_  # terminal facts (the ending)
fragua runs events "$RUN" [--type <prefix>] [--limit N] [--json]   # full timeline; --json = raw payloads

fragua runs steps "$RUN" [--json]           # per-LLM-call snapshots; --json = resolved prompts
fragua runs messages "$RUN" [--node <id>] [--json]   # transcript; default preview, --json = full blocks
fragua runs artifacts "$RUN"                # list artifacts
fragua runs artifact "$RUN" <nodeId> --key <k> [--iteration N]   # dump one blob's body
fragua runs diff "$RUN"                     # worktree base..tip diff

fragua schedule list                        # current schedule rows
fragua providers ls                         # credentialed providers (✓ = present)
fragua providers ls-models <provider>       # model entries: ctx / max / reasoning / cost
```

Operator intents (steer / pause / cancel / respond / unquarantine / priority / budget / max-retries / goal-gate / max-loops / resume) change state — they're the operate skill's control plane, not debugging tools. Present evidence; let the user decide whether to write one.
