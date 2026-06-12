# fragua CLI reference

The full command surface. The README covers the bread-and-butter; this is the
exhaustive reference.

The CLI is a **direct store-client**: every verb opens the local SQLite store
and reads/writes through the intent + read planes — no HTTP round-trip, no
running server required to enqueue or inspect. The one exception is `fragua ci`,
which *embeds the executor* (it writes `fact.*` itself). A daemon (via `fragua
harness`) is what *executes* queued runs; with none running, a run sits `queued`
and a follow/tail waits.

> `fragua` and `bun run fragua <args…>` are interchangeable on a checkout.

**Common flags.** Store-client verbs take `--db <path>` (default
`~/.fragua/fragua.db`, the harness store) and, where relevant, `--cwd <dir>`.
`fragua run` / `fragua daemon` / `fragua serve` default the store to
`<cwd>/.fragua/fragua.db`; the `runs` operate verbs default to the harness store.

---

## providers & models — `fragua providers <action>`

```sh
fragua providers add [provider]          # add credentials; --custom for an OpenAI-compatible provider
fragua providers ls                      # configured providers + default models
fragua providers rm | test | login | logout <provider>
fragua providers {ls,add,rm,edit}-model  <provider> <id> [flags]
```

`add-model` / `edit-model` flags: `--name`, `--context-window`, `--max-tokens`,
`--reasoning`, `--input text,image`, `--cost-input`, `--cost-output`, `-y`.

---

## create runs — `fragua run <workflow>`

```sh
fragua run <workflow> [-i name=value]… [--title <t>] [--priority <n>] [--no-follow]
                      [--cwd <dir>] [--db <path>]
```

`<workflow>` resolves: a bare name → `~/.fragua/workflows/<name>.yaml` then
`<cwd>/.fragua/workflows/<name>.yaml`; anything with `/` or a `.yaml` suffix is a
literal path. `-i name=value` binds the typed inputs declared in the workflow's
`inputs:` block (`@path` reads a file, `@-` reads stdin). Saves + enqueues, then
**follows by default** (streams the event log to terminal, answering HITL gates
inline on a TTY); `--no-follow` prints the run id and exits. The exit code
reflects the run's outcome (see [Exit codes](#exit-codes)).

---

## operate on runs — `fragua runs <verb> [runId]`

Plural operates on an existing run; singular (`run`) creates one. Every verb is a
store-client; control verbs append an `intent.*` the daemon folds on its next
tick (always-appendable, so they succeed even with the daemon down).

```sh
fragua runs ls [--status running,paused_human] [--limit N] [--json]  # one line per run (--json: array)
fragua runs inbox [--json]                                           # runs needing attention (2 sections)
fragua runs status <id> [--json]                                     # lifecycle + outcome + warnings
fragua runs tail <id> [--full]                                       # follow an existing run's log to terminal (live)
fragua runs explain <id> [--json]                                    # narrative: path, per-step cost/outcome, diff, reason
fragua runs worktree <id>                                            # print the absolute worktree path (exit 1 if cleaned up)

# disposition — nothing touches your git until you ask
fragua runs diff    <id> [--against base|previous|<idx>] [--snap <idx>] [--path <p>]
fragua runs accept  <id>                          # replay the run's commits onto your branch + stage the tail
fragua runs discard <id>                          # drop the run's fragua refs

# lifecycle + control
fragua runs respond <id> [route] [--note "…"]     # answer a HITL gate (interactive without a route)
fragua runs resume  <id> [--note "…"]
fragua runs cancel  <id> [--reason "…"]
fragua runs unquarantine <id> --resolution treat_as_done|retry|cancel
fragua runs steer   <id> "<text>"                 # nudge the next LLM call; aborts + re-dispatches
fragua runs pause   <id>
fragua runs priority <id> <n>

# ceiling raisers (paused runs — raise the cap, then resume)
fragua runs budget      <id> --scope <s> --metric <m> --new-limit <n>
fragua runs max-retries <id> <n> --node <id>
fragua runs goal-gate   <id> <n>
fragua runs max-loops   <id> <n>

# inspect (forensics — no raw SQL)
fragua runs events    <id> [--type <prefix>] [--limit N] [--since <seq>] [--json]
fragua runs steps     <id> [--json]               # per-LLM-call cost / tokens / duration
fragua runs messages  <id> [--node <id>] [--json] # the LLM-visible transcript
fragua runs artifacts <id>                        # list a run's artifacts
fragua runs artifact  <id> <nodeId> --key <k> [--iteration N]   # one artifact's bytes to stdout
```

`fragua runs status` surfaces any active soft budget warning (the 80% mark
before the hard pause); `fragua runs tail` prefixes the same event with ⚠ in
the live log. `fragua runs explain` synthesises the full narrative: path taken,
per-step outcome and cost, diff-vs-base summary, and the terminal reason.

`fragua runs tail` backfills the last 200 events before going live (the bound
is a SQL-level read — long runs never hydrate the full log); pass `--full` to
replay the entire log. `fragua runs events` prints the last 50 by default;
`--limit N` keeps the last N matching events, and `--since <seq>` keeps only
events with seq strictly greater than `<seq>` (unbounded unless `--limit` is
also given — a forward cursor for scripts).

Discovery flags on the `runs` verbs: `--cwd` (scopes `ls`/`inbox`, resolves
`diff` worktrees) and `--db` (default: the harness store `~/.fragua/fragua.db`).

---

## move runs between stores — export / import

```sh
fragua runs export <id> --to <file.fragua>   # write the run as a portable bundle
fragua show <file.fragua>                    # inspect a bundle without importing it
fragua import <file.fragua>                  # merge a bundle's runs into a store (default: the harness store)
```

A `.fragua` bundle carries the run's event log, transcript, workflow, and
artifact blobs — `run_state` is re-derived on import by replaying the event
log, and an imported run is inert (its derived `cwd` is null), so the daemon
never picks it up.

**Bundles are secret-free by construction — with one residual.** Export runs a
scrubber over every *text* surface (messages, event payloads, routing inputs,
text-ish artifacts), replacing credentials with `[REDACTED]` markers. **Binary
artifacts are not scrubbed** — they are only *scanned*: if a live credential
value appears verbatim inside a binary blob, the export still succeeds but
reports `liveLiteralHit=true` and prints a warning.

**Policy for a `liveLiteralHit` bundle: treat it as secret-bearing.** Do not
share it, publish it, or attach it to CI artifacts without first rotating the
implicated credential (or re-exporting after removing the offending binary
artifact). `fragua runs export` warns and continues; `fragua ci --export`
fails closed on the same condition with exit code `80` (see
[Exit codes](#exit-codes)).

---

## one-shot CI — `fragua ci <workflow>`

```sh
fragua ci <workflow> [-i name=value]… [--json] [--provider <id>] [--model <id>]
                     [--cwd <dir>] [--db <path>]
```

Embeds the executor over an **ephemeral store** (a temp dir, or `--db`-pinned to
keep the `.db` as a portable artifact), drives the run to a terminal/stop state,
and exits with the outcome code. Credentials come from the environment
(`ANTHROPIC_API_KEY`, …). `--json` emits the event log as JSONL instead of the
human render. Continues the `paused_auto` retry arm like the daemon; stops
(non-zero) on a terminal state or an unanswerable pause (`paused`,
`paused_human`, `quarantined`).

---

## schedules — `fragua schedule <action>`

```sh
fragua schedule add <workflow> --every 1h [-i "…"] [--on-overlap skip|queue|concurrent] [--no-fire-on-create]
fragua schedule list | pause <id> | resume <id> | rm <id>
```

`--every` accepts `30m | 1h | 6h | 24h | 3d | 7d`.

---

## server / daemon primitives

```sh
fragua harness [--port <n>] [--db <path>]                 # daemon + HTTP under one supervisor (:6767)
fragua serve   [--port <n>] [--cwd <dir>] [--db <path>]   # HTTP + SSE only
fragua daemon  start [--concurrency <n>] [--provider <name>] [--model <id>] [--cwd <dir>] [--db <path>]
fragua daemon  stop                                       # SIGTERM the daemon holding the store lock
```

Server discovery is store-resident: whoever binds the HTTP listener (the
harness's in-process server, or a standalone `serve`) writes its URL into the
store's `server_endpoint` row and clears it on shutdown. `@fragua/web` reads that
row — there is no `serve.json` file and no localhost default.

---

## maintenance & authoring

```sh
fragua validate <workflow.yaml>          # parse + lint, no execution; reports tool steps using the default 5-min timeout
fragua init [--cwd <path>]               # write <cwd>/.fragua/config.yaml
fragua doctor                            # liveness: store path, daemon lock, server endpoint, providers
fragua gc --snapshots [--older-than 30d] [--dry-run]
fragua db vacuum                         # reclaim free pages
fragua db gc-blobs [--limit N]           # delete orphaned blob rows
fragua db backup --to <path>             # online backup to a file
fragua db migrate [--to <version>] [--dry-run] [--allow-data-loss] [--no-backup]
```

`validate` is **store-free**: it never opens `~/.fragua/fragua.db` (or any
store), so it works in CI and editor contexts with no DB present. Model ids
are checked against the bundled offline pi-ai registry: a near-miss typo of a
known id (wrong separator, e.g. `claude-sonnet-4.6` for `claude-sonnet-4-6`)
is an error; an id absent from the bundled registry is only a *warning* —
it may be a custom model registered in a store's `provider_config` table,
which `validate` cannot see. The authoritative model check happens at
enqueue, against the store-backed registry.

`db migrate` is the manual schema-version path: store-client verbs open
*without* migrating and, on a version mismatch, point here. Direction is
inferred from `--to <version>` vs the store's current version:

- **omitted / `--to CURRENT`** — forward to the current version (today's
  behaviour).
- **`--to <lower>`** — **downgrade**: walks each step's `down` inverse in
  descending order, then pins the target. A downgrade must be run by the
  *newer* binary — the one that defines the `down` steps — after which you
  switch back to the older binary, which then opens the store cleanly. A step
  with no `down` refuses the walk (naming it); a step that loses data needs
  `--allow-data-loss`.
- **`--to <higher>`** — forward to that version (may stop short of CURRENT).

`--dry-run` prints the ordered plan with each step's reversibility class
(`full` / `lossy` / `irreversible`) and applies nothing. Every operator-invoked
migrate serializes a pre-migrate backup beside the store
(`<store dir>/backups/pre-migrate-v{from}-to-v{to}-<ts>.db`) first; `--no-backup`
opts out for ephemeral / CI stores. A migrate refuses if a harness is live
against the store (its `daemon_lock` heartbeat is fresh) — stop it first.

The harness/daemon auto-migrate forward under their lock; that automatic path
never downgrades — only this explicit, backed-up command does.

---

## Exit codes

`ci`, `run --follow`, and `runs tail` all exit through the same status+reason →
code map (`packages/cli/src/cli-exit.ts` `cliExitCode`), so a script can
`case $?` on exactly how a run stopped. Codes are banded by status class.

| Code | Meaning |
|---|---|
| `0` | `completed` — the only zero |
| `1` | couldn't run the workflow at all (not found / unparseable / bad config) |
| `10`–`17` | `halted` by reason — `error` 10, `aborted_exit` 11, `budget` 12, `occ_exhausted` 13, `timeout_exhausted` 14, `route_not_picked` 15, `route_call_not_isolated` 16, `edge_no_match` 17 |
| `30`–`39` | `paused` by reason — `operator` 30, `provider_error` 31, `payment_required` 32, `budget` 33, `max_retries` 34, `goal_gate` 35, `max_loops` 36, `abort_loop` 37, `provider_exhausted` 38, `engine_incompatible` 39 |
| `50`–`51` | `quarantined` — `orphan_side_effect` 50, `other` 51 |
| `60` | `paused_human` — the workflow asked a question (no responder) |
| `70` | a non-terminal status reached as a stop-state (a driver bug) |
| `80` | `ci` bundle's binary artifact contains a live secret value verbatim (scrubber perimeter — text surfaces are always scrubbed; binary artifacts are scanned-and-fail-closed) |
| `130` | `cancelled`, or a SIGINT/SIGTERM interrupt |

Pipelines branch on these: retry on `13`/`14` (transient), top up on `32`,
escalate to a human on `60`, hard-fail + alert on `80` (a live secret reached a
published bundle). Each engine reason is a public code — the per-reason
maps are exhaustive over the type unions, so adding a reason is a deliberate CLI
contract change.

---

## developing on the repo

```sh
bun run {typecheck, lint, format, ci}   # ci = lint + typecheck + tests
bun test                                # all package suites
bun run dev:web                         # Vite dev server (:5173), proxies /api to a running harness
bun run build:bin                       # compile dist/fragua
```
