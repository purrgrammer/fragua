---
name: operate
description: Drive AND diagnose a fragua run — enqueue, steer, land, and debug. Load this when the user says "run workflow X", "kick off change", "enqueue work", "start a run against …", "steer this run", "pause/cancel/resume run …", "send HITL input", "unquarantine <run>", "bump priority on …", "raise the retry/loop/goal-gate cap", "land/accept this run", "what's the status of run …", "tail/follow this run", "why did run X fail/hang/halt/pause", "what happened to <run>", "debug/diagnose this run", "is it stuck", "export this run", "import a run bundle", "inspect a CI run locally", or otherwise asks to operate on or investigate a run. Teaches pre-flight (provider credentials + a running harness so runs execute), enqueue (`fragua run`), watch + review (`fragua runs ls|inbox|status|tail|diff`), the operate verbs (`fragua runs steer|pause|cancel|resume|respond|unquarantine|priority|budget|max-retries|goal-gate|max-loops`) with post-conditions, landing work (`fragua runs accept|discard`), moving runs between stores as a portable secret-free bundle (`fragua runs export` / `fragua show` / `fragua import`), and the HITL + quarantine protocols. Everything is a `fragua` CLI verb — no direct queries. Deep forensics on a failed/stuck run (the failure-mode playbook, transcript, per-call cost, artifacts) live in the load-on-demand reference `references/forensics.md`. Assumes the `fragua` CLI (on PATH, or `bun run fragua` in a checkout).
---

# operate — enqueue, watch, and control a live run

Go from a workflow (a bare name under `~/.fragua/workflows/` or `<cwd>/.fragua/workflows/`, or a literal `.yaml` path) to a running, observable run you can steer, land, and debug — **entirely through the `fragua` CLI, no direct queries**. Every action below is a `fragua` subcommand. When a run fails or hangs and the summary isn't enough, read the forensics reference (§10) — the failure-mode playbook + deep `--json` reads — loaded on demand.

Authoritative references: [`docs/cli.md`](../../../docs/cli.md) (every verb + flag + exit codes), [`docs/SPEC.md`](../../../docs/SPEC.md) §3 (primitives + control plane), [`docs/ARCHITECTURE.md`](../../../docs/ARCHITECTURE.md) §3 (event taxonomy).

---

## Fast path

```sh
fragua runs ls          # lists runs (reads the local store; no harness needed)
fragua providers ls     # at least one provider shows ✓

# Run. --input name=value (repeatable) binds the typed inputs declared in the
# workflow's `inputs:` block; --title sets the run title.
fragua run change --input task="rename foo() to bar() in packages/core"
fragua run deploy --input ticket=BUG-1 --input env=prod
```

`fragua run` saves the workflow, enqueues, and tails its event log until terminal. Terminal facts: `fact.run_completed | fact.run_halted | fact.run_cancelled | fact.run_paused_human | fact.run_paused | fact.run_quarantined`. Its exit code reflects the outcome — `0` completed, non-zero banded by halt / pause / quarantine reason (the same `cliExitCode` map `fragua ci` uses; full table in [`docs/cli.md`](../../../docs/cli.md#exit-codes)). A `paused_human` gate prompts you inline (on a TTY — answer and it keeps following) or exits `60` for `fragua runs respond`; `paused_auto` resumes itself on the retry timer.

> `fragua` and `bun run fragua <args…>` are interchangeable on a checkout; this doc uses the bare binary.

If the fast path works, nothing else here matters.

---

## 1. Pre-flight

The harness is one foreground process that runs the daemon (which executes runs). CLI verbs act directly on the local store — `~/.fragua/fragua.db`, or `--db <path>` for another instance — so they work even with the harness down; but a queued run only *makes progress* while the harness is running.

```sh
fragua runs ls          # lists runs (store read; succeeds with or without a harness)
fragua providers ls     # configured providers; ✓ = credentialed
```

`fragua runs ls` is not a liveness check — it reads the store and succeeds whenever the store exists. The harness's only job is *executing* runs; you can't tell it's down by listing — the symptom is a run that never leaves `queued`.

Common failures:

- **`fragua runs ls` errors** — no store at this path. `fragua harness` creates `~/.fragua/fragua.db` on first start; or check `--db`.
- **Runs stuck `queued`** — no harness running (or its daemon died / heartbeat stale): nothing is executing the queue. Start/restart `fragua harness` — but the user should run it themselves (don't start it on their behalf without asking; it attaches to the current shell).
- **Provider not credentialed** — enqueue fails `provider_unavailable`. Fix: `fragua providers add <provider>` or `fragua providers login <provider>`.
- **Model not registered** — enqueue fails `model_unresolved`. Register it (`fragua providers add-model <provider> <id> [--context-window N --max-tokens N --reasoning --input text,image --cost-input X --cost-output X --yes]`, or the full `fragua providers add --custom` wizard for a new provider) or switch the workflow's `model:`.

---

## 2. Enqueue — `fragua run`

```sh
fragua run <workflow>  \
  [--input name=value]   # typed input; repeat for several (gh-style)
  [--title "…"]          # set the run title now (suppresses the auto-titler)
  [--priority 10]        # higher runs first (queue tie-breaker)
  [--no-follow]          # enqueue and exit; print only the run id
  [--db path/to/db]      # target a specific store (default ~/.fragua/fragua.db)
```

`<workflow>` resolves: bare name → `~/.fragua/workflows/<name>.yaml` first, then `<cwd>/.fragua/workflows/<name>.yaml`; anything with `/` or ending `.yaml` is a literal path. `--input name=value` binds typed inputs (`${{ inputs.name }}`; a value `@path`/`@-` reads a file/stdin); a missing required input or out-of-range `choice` is rejected at enqueue. The run id prints immediately; terminal facts stream colorised (follow by default; `--no-follow` to opt out).

---

## 3. Watch a run

```sh
fragua runs ls [--status queued,running,…] [--limit N]   # one line per run: id · status · title
fragua runs inbox                                        # runs awaiting an operator decision (2 sections)
fragua runs status <id>                                  # one run: lifecycle + outcome + the why (pause/halt reason, quarantine orphans, HITL gate)
fragua runs tail <id>                                    # follow an existing run's event log to terminal (live)
fragua runs diff <id> [--against base|previous|<eventIdx>] [--snap <eventIdx>] [--path <p>]   # review the change
```

`fragua run` tails the run it enqueues; to watch a run you *didn't* just start, `fragua runs tail <id>` (live event log to terminal, same renderer + inline HITL picker); for a one-shot snapshot, `fragua runs status <id>`. `inbox` is the operator's worklist: **NEEDS INPUT** (blocked: HITL / paused / quarantined) and **READY TO LAND** (terminal runs with recoverable work + diffstat).

**Two status words, don't conflate.** Lifecycle (`queued | running | completed | halted | cancelled | paused | paused_human | paused_auto | quarantined`) answers "still going?"; outcome (`success | fail | null`) answers "did it succeed?" once terminal. `fragua runs ls` shows the lifecycle status.

**Move a run between stores (experimental).** A run that executed elsewhere — a CI `.fragua` artifact, a teammate's box — imports into your store so you can inspect it here:

```sh
fragua runs export <id> --to <file.fragua>   # write a run as a portable, secret-free bundle
fragua show <file.fragua>                     # validate + summarize a bundle (no store needed)
fragua import <file.fragua> [--db <target>]   # merge its runs into a store (default: the harness store)
```

A bundle is its own entity: it carries each run's raw **event log**, transcript, workflow, and artifact blobs — **never credentials** (secret-free by construction), and **no `run_state`** (that's a projection, re-derived on import by replaying the log). `fragua ci --export <file.fragua>` writes the same bundle for the run it just executed. `import` is a store-client like the other verbs — it lands in an **existing** store (never creates or migrates one); the imported run is **inert** (its derived `cwd` is null, so the daemon never picks it up), and `runs status|events|messages <id>` work against it. A bundle from a newer engine still imports for inspection — only *resume* would gate on the contract version, and resume of an imported run isn't supported (inspect, not resume). The format and verbs are release-gated and may change.

```sh
# Poll to terminal (lifecycle status, not outcome):
until fragua runs ls --limit 50 | grep "$RID" \
      | grep -qE 'completed|halted|cancelled|paused_human|paused|quarantined'; do sleep 30; done
```

**Lifecycle states beyond `running`/`completed`:**

- `queued` — waiting for a dispatch slot. Not broken; no daemon = no dispatch.
- `paused_human` — a `human` node yielded. Answer with `fragua runs respond` (§5).
- `paused` — operator-resumable. `fragua runs status <id>` surfaces the reason: `operator` / `provider_error` (fix creds/request) / `payment_required` (top up the provider) / `budget` (raise via `fragua runs budget`, then `resume`) / `max_retries` / `goal_gate` / `max_loops` (raise the cap via `fragua runs max-retries|goal-gate|max-loops`, then `resume` — §4) / `abort_loop` / `provider_exhausted` (naked `resume` only) / `engine_incompatible` (daemon version mismatch; heals when a capable daemon runs).
- `paused_auto` — daemon owes a clock tick (`provider_retry`, `handler_retry`, or `timeout_retry`); frees its slot and re-queues itself when the backoff passes. No action unless the timer never fires (check the harness). Short-circuit with `fragua runs resume`.
- `quarantined` — orphan side effect; resolve with `fragua runs unquarantine` (§6).
- `halted` / `cancelled` — terminal. `fragua runs status <id>` shows the halt `reason` + detail; for deep failure analysis (transcript, the failing step), the forensics reference (§10).

If the last event is `fact.node_started` with no follow-up past the node's `maxMs` and the watchdog hasn't fired, the daemon is wedged — run `fragua doctor`, then the forensics reference (§10).

---

## 4. Control plane — `fragua runs <verb>`

Each verb appends an `intent.*` event the daemon folds on its next tick (~50ms); intents are **always appendable** (no OCC), so a verb succeeds even if the daemon hasn't acted yet. Each prints the intent `seq` — quote it so the user can find the action in the stream.

| Command | Intent | Post-condition |
|---|---|---|
| `fragua runs steer <id> "<text>"` | `intent.steering_requested` | Handler aborts (`cause:"steer"`); next dispatch sees the text in the thread. |
| `fragua runs pause <id>` | `intent.pause_requested` | Handler aborts (`cause:"pause"`); → `paused` (`reason:"operator"`). |
| `fragua runs cancel <id> [--reason <t>]` | `intent.cancel_requested` | Handler aborts; terminal `fact.run_cancelled`. No resume path. |
| `fragua runs resume <id> [--note <t>]` | `intent.resume` | Any `paused_*` run → `queued`. |
| `fragua runs respond <id> [route] [--note <t>]` | `intent.human_input` | Answers a `paused_human` gate; route must be in the gate's enum (§5). |
| `fragua runs unquarantine <id> --resolution treat_as_done\|retry\|cancel` | `intent.unquarantine` | Resolves an orphan side effect (§6). |
| `fragua runs priority <id> <n> [--note <t>]` | `intent.priority_adjusted` | Re-orders the queue; running runs unaffected. |
| `fragua runs budget <id> --scope <s> --metric <m> --new-limit <n> [--note <t>]` | `intent.budget_adjusted` | Raises a cap; doesn't wake on its own — pair with `resume`. |
| `fragua runs max-retries <id> <n> --node <nodeId> [--note <t>]` | `intent.max_retries_adjusted` | Raises one node's handler-retry cap on a `paused{reason:"max_retries"}` run; pair with `resume`. |
| `fragua runs goal-gate <id> <n> [--note <t>]` | `intent.goal_gate_adjusted` | Raises the goal-gate retry cap on a `paused{reason:"goal_gate"}` run; pair with `resume`. |
| `fragua runs max-loops <id> <n> [--note <t>]` | `intent.max_loops_adjusted` | Raises the per-run dispatch ceiling on a `paused{reason:"max_loops"}` run; pair with `resume`. |

The last four (`budget` / `max-retries` / `goal-gate` / `max-loops`) only raise a ceiling — they never wake the run. Always follow with `fragua runs resume`.

### Steering

Injects text into the next LLM call's thread; the current handler aborts losslessly and re-dispatches. Use small, specific nudges. After `fragua runs steer`, expect `fact.node_aborted { cause:"steer", intentSeq: <seq> }` → `fact.node_started` for the same node with `iteration` bumped. Long essays are the wrong tool — prefer `cancel` + a fresh run with a better prompt.

### Pause / cancel

`pause` is steer-without-text (resume later); `cancel` is terminal (no resume). When unsure, `pause` and decide later.

---

## 5. Human resume protocol

A `paused_human` run waits for input. `fragua runs respond <id>` (no route) renders an arrow-key menu of the gate's routes (human-readable labels) and reads your choice; `fragua runs respond <id> <route>` answers directly (scriptable). The route must be one of the gate's declared options — the CLI rejects an off-list route. A followed `fragua run` shows the same picker inline when it reaches the gate, then keeps following.

Present the decision to the user — don't answer on their behalf unless they've explicitly delegated it.

---

## 6. Quarantine resolution

A run lands in `quarantined` when the startup sweep finds a side-effect intent with no matching done/failed. The external effect may have succeeded, failed, or never landed — fragua can't tell, so the operator decides:

```sh
fragua runs unquarantine <id> --resolution treat_as_done|retry|cancel --note "<evidence>"
#   treat_as_done — assume it completed (strong provider idempotency)
#   retry         — replay (verified external state matches a re-try)
#   cancel        — stop the run (blast radius unclear)
```

Inspect the orphaned intents first — `fragua runs status <id>` lists them (the `quarantined:` line) — and present options + evidence to the user. Never auto-choose.

---

## 7. Landing work — the inbox

A terminal run that left recoverable agent work sits in `fragua runs inbox` under **READY TO LAND**. Land or drop it:

```sh
fragua runs accept <id>    # replay the run's commits onto your current branch (HEAD in the run's cwd)
                           # + stage the uncommitted tail → `git commit` when ready
fragua runs discard <id>   # drop the run's refs/fragua/{snapshots,heads}/<id> (final)
```

`accept` runs synchronously and prints `accepted (run <id>, replayed N; tail staged …)`. It refuses with a non-zero exit + reason on `conflict` (doesn't merge cleanly), `dirty_tree` (uncommitted local changes — stash/commit first), or `no_work`. Review with `fragua runs diff <id>` before accepting. `discard` is terminal — a later `accept`/`discard` on a discarded run exits non-zero with `discarded`.

---

## 8. Schedules — recurring runs

A schedule fires a workflow on a fixed interval (`30m` / `1h` / `6h` / `24h`; cron is out of scope). Each fire enqueues a normal run carrying `schedule_id` lineage. Skip-on-overlap is the default; one coalesced catch-up after downtime.

```sh
fragua schedule add <workflow> --every 1h                 # create + fire immediately
fragua schedule add change --every 24h --input "sweep deps" --no-fire-on-create
fragua schedule list [--cwd <dir>]                         # tabular health view
fragua schedule pause | resume | rm <sch_id>               # resume: no catch-up; next fire = now + interval
```

If a schedule's workflow goes missing/unparseable at fire time, the dispatcher records `fact.schedule_invalid_workflow` and auto-pauses it — fix the file and `fragua schedule resume`. Transient run failures don't pause the schedule (maintenance workflows are idempotent).

---

## 9. Anti-patterns

- **Don't spam steer.** 5 aborts without progress halts the run with `reason:"abort_loop"`; usually `cancel` + re-enqueue with a better prompt is right.
- **Don't write intents the user didn't ask for.** Steer / pause / cancel / unquarantine can lose work or change external state. Present evidence, let the user decide.
- **Don't `accept` over a dirty tree.** Commit/stash local changes first, or it refuses with `dirty_tree`.
- **Don't assume one daemon.** Parallel fraguas (different `--db`) coexist; pass `--db` to target one.
- **Don't treat `queued` as broken.** No daemon = no dispatch. Check the harness first.

---

## 10. Forensics — `references/forensics.md`

`runs status` + `runs events` answer most "why" questions. When they don't — a run failed or hung and you need the deep evidence — **read [`references/forensics.md`](references/forensics.md)** (load it on demand). It's the diagnosis playbook on CLI verbs: the failure-mode table (every halt/pause `reason` → the fix), the fact-event taxonomy, and the deep reads — `fragua runs events --json`, `runs steps --json`, `runs messages --json`, `runs artifacts`/`artifact`, and `fragua doctor` for instance/daemon liveness. All `fragua` verbs; SQLite appears only for the two reads with no verb yet (schedule audit trail, raw provider creds).
