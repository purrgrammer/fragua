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
fragua providers rm | test | login | logout <provider>   # `test typesafe` makes one judge call
fragua providers {ls,add,rm,edit}-model  <provider> <id> [flags]
```

`add-model` / `edit-model` flags: `--name`, `--context-window`, `--max-tokens`,
`--reasoning`, `--input text,image`, `--cost-input`, `--cost-output`, `-y`.

---

## create runs — `fragua run <workflow>`

```sh
fragua run <workflow> [-i name=value]… [--title <t>] [--priority <n>] [--base <ref> | --dirty | --checkout <path>]
                      [--no-follow] [--cwd <dir>] [--db <path>]
```

`<workflow>` resolves: a bare name → `~/.fragua/workflows/<name>.yaml` then
`<cwd>/.fragua/workflows/<name>.yaml`; anything with `/` or a `.yaml` suffix is a
literal path. `-i name=value` binds the typed inputs declared in the workflow's
`inputs:` block (`@path` reads a file, `@-` reads stdin). `--base <ref>` pins the
run's worktree base to a branch, tag, or sha: the ref is resolved to a commit sha
**at enqueue** (`git -C <cwd> rev-parse --verify <ref>^{commit}`) and stored on the
run, so the worktree is provisioned from that sha (`git worktree add --detach`)
regardless of where the cwd's HEAD moves afterward; an unresolvable ref is rejected
before the run is minted. Without `--base`, the run is based on the cwd's HEAD
**at enqueue**: its sha and branch are recorded on the run the same way, so moving
the checkout afterward does not change the base.

Every enqueue prints the base it resolved, before `run queued`:

```
base: <branch> @ <short sha> (clean | dirty: N files | detached)
```

(`HEAD` stands in for the branch when detached; a `--checkout` run shows the
checkout's HEAD with `captured at first start`, and records nothing until then.)
When the base is neither the project's default branch (`origin/HEAD`'s target,
else `main`, else `master`) nor an explicit `--base`, a yellow notice follows; the
run is still enqueued:

```
note: basing on <branch>, not <default>; pass --base <default> to pin
```

The recorded base surfaces on `fragua runs status` (and `--json`'s
`baseGitRef` / `baseGitSha`) while the run is still queued. `fragua ci` prints
neither line and records no base.

`--dirty` bases the run on your uncommitted working tree: at enqueue the CLI
captures the checkout's index plus untracked, non-ignored files (ignored files and
the run's own `.fragua/` state excluded) into a synthetic commit parented on HEAD,
pins it as the run's base, and keeps it at `refs/fragua/bases/<run_id>`. Your index
and HEAD are not touched. Inside the worktree the agent sees your WIP committed at
HEAD (untracked files tracked), and `runs diff --against base` shows only the run's
own work. A clean tree falls back to HEAD (`--dirty: working tree is clean, using
HEAD`). `runs status` shows `dirty base over <short HEAD>`. It refuses — writing no
run, event or ref — with `--base` (`--dirty cannot combine with --base: the dirt is
relative to HEAD`), outside a git checkout, on a repo with no commits (`--dirty needs
a commit to capture over: <checkout> has no commits yet`), and on a checkout whose
`.gitignore` lacks the fragua state block (run `fragua init`). Caveat: a branch the
run pushes descends from the captured commit, so pushing it publishes your WIP,
untracked files included.

`--checkout <path>` — *Run inside this existing checkout of the repository (no
per-run worktree; the run's changes land directly in it). Use . for the current
one.* `<path>` is any directory inside a checkout; the run is keyed on that
checkout's toplevel (realpath). It is accepted only when the checkout belongs to
the same repository as the project (same `git rev-parse --git-common-dir`), is not
a fragua-owned run worktree (`.fragua/worktrees/<id>`), has at least one commit,
and ignores the fragua state block. Otherwise the enqueue refuses, writing nothing:
`checkout_missing`, `checkout_unregistered`, `checkout_fragua_owned`,
`checkout_unborn`, or the `fragua init` hint. It cannot be combined with `--base`
(honouring it would require checking out the ref in a checkout fragua does not
own) or `--dirty` (`--dirty` asks for a fresh per-run worktree and `--checkout`
asks for none). Neither `fragua schedule`, `fragua ci` nor the web enqueue accepts
it.

The run's base is the checkout's state when the run **first starts**: HEAD when the
tree is clean, otherwise a synthetic commit over HEAD kept at
`refs/fragua/bases/<run_id>`. Your index, HEAD and branch are never reset, checked
out, stashed or removed by fragua; the agent may commit or switch branches there as
any workflow could. `runs diff --against base` shows everything the run did to the
checkout. `runs status` shows `in checkout <path>`.

**One run per checkout.** A checkout is *held* by any run on it that is not yet
released: queued, running, paused, quarantined, or terminal-but-unreleased. While
it is held, a second `--checkout` run on it, a `--dirty` run over it, and an
`accept` into it all refuse with `checkout_busy`:

```
checkout <path> is held by run <id> (<status>); wait for it to finish, or run `fragua runs release <id>` once it is terminal
```

A checkout run releases on its own when it completes and its terminal snapshot is
recorded, or when it ends without ever starting (cancelled while queued, a
first-attach failure). A run that halts, is cancelled after it started, or
completes without a recorded snapshot keeps the checkout until you run
`fragua runs release <id>` (below). This is a read, not a lock: two commands
started at the same moment on one checkout, or one checkout reached through two
stores, can still collide — an operator-concurrency hazard.

**Iterating on a branch (the PR-review pattern).** Iterate *on* the branch with a
checkout run, rather than having a detached run check the branch out:

```sh
git worktree add ../feature-wt feature                     # once
fragua run work   --checkout ../feature-wt --input task=…  # feature work
fragua run review-fixes --checkout ../feature-wt --input pr=123
fragua run review-fixes --checkout ../feature-wt --input pr=123
```

Each run starts from the previous one's result; commit and push from
`../feature-wt` whenever you choose. A run that halts or is cancelled holds the
checkout until `fragua runs release`. `--checkout .` on the main checkout works the
same way when you are on `feature` there.

Saves + enqueues, then
**follows by default** (streams the event log to terminal, answering HITL gates
inline on a TTY); `--no-follow` prints the run id and exits. The exit code
reflects the run's outcome (see [Exit codes](#exit-codes)).

---

## operate on runs — `fragua runs <verb> [runId]`

Plural operates on an existing run; singular (`run`) creates one. Every verb is a
store-client; control verbs append an `intent.*` the daemon folds on its next
tick (always-appendable, so they succeed even with the daemon down).

```sh
fragua runs ls [--status running,paused_human] [--limit N] [--summary] [--json]  # one line per run (--json: array; --summary: fleet rollup)
fragua runs inbox [--json]                                           # runs needing attention (2 sections)
fragua runs status <id> [--json]                                     # lifecycle + outcome + warnings
fragua runs tail <id> [--full]                                       # follow an existing run's log to terminal (live)
fragua runs explain <id> [--json]                                    # narrative: path, per-step cost/outcome, diff, reason
fragua runs worktree <id>                                            # print the absolute worktree path (exit 1 if cleaned up)
fragua runs wait <id...> | --workflow <name> | --all-running         # block until every selected run settles (no HTTP)
     [--timeout <dur>] [--settle terminal|blocked]                   #   exit 0 / banded (halt/quarantine) / 60 (blocked) / 75 (timeout)

# disposition — nothing touches your git until you ask
fragua runs diff    <id> [--against base|previous|<idx>] [--snap <idx>] [--path <p>]
fragua runs accept  <id> [--autostash] [--onto <branch> | --force-branch]
                                                  # replay the run's commits onto your branch + stage the tail
                                                  #   prints `target: <branch> @ <sha>` first; refuses wrong_branch off the run's base branch
                                                  #   --onto <branch>: land on this (checked-out) branch instead; --force-branch: skip the check
                                                  #   --autostash: stash unrelated dirty files around the apply, then restore them (mirrors git rebase --autostash)
                                                  #   a run that commits on its own branch (agent/$FRAGUA_RUN_ID) is not in the inbox: land it via that branch
                                                  #   a --dirty run lands as unstaged changes instead (see below); --autostash is ignored
fragua runs discard <id>                          # drop the run's fragua refs (never refs/fragua/bases/<id>)
fragua runs release <id>                          # free a terminal --checkout run's hold on its checkout

# lifecycle + control
fragua runs respond <id> [route] [--note "…"]     # answer a HITL gate (interactive without a route)
fragua runs resume  <id> [--note "…"]
fragua runs cancel  <id> [--reason "…"]
fragua runs unquarantine <id> --resolution treat_as_done|retry|cancel
fragua runs steer   <id> "<text>"                 # nudge in-flight LLM branches; reports delivered/buffered
fragua runs pause   <id>
fragua runs priority <id> <n>

# ceiling raisers (paused runs — raise the cap, then resume)
fragua runs budget      <id> --scope <s> --metric <m> --new-limit <n>
fragua runs max-retries <id> <n> --node <id>
fragua runs goal-gate   <id> <n>
fragua runs max-loops   <id> <n>

# inspect (forensics — no raw SQL)
fragua runs events    <id> [--type <glob>] [--limit N | --all] [--since <seq>] [--json]
fragua runs steps     <id> [--json]               # per-LLM-call cost / tokens / duration
fragua runs messages  <id> [--node <id>] [--all] [--json] # the LLM-visible transcript
fragua runs artifacts <id>                        # list a run's artifacts
fragua runs artifact  <id> <nodeId> --key <k> [--iteration N]   # one artifact's bytes to stdout
```

**Accepting a `--dirty` run.** A dirty-base run (`runs status` shows `dirty base
over <sha>`) lands as **unstaged working-tree changes**: HEAD, your branch and your
index are untouched, and only the paths the run changed (S→P: the captured base to
the run's snapshot) are written. It does not need a clean tree, and `--autostash` is
ignored (the CLI says so). Success prints:

```
landed as unstaged changes in <cwd>: <n> files (+a/-d); undo: git restore --source=<S> --worktree -- <paths>; plus delete: <created paths>
```

Undo is exactly that: restore the changed paths from S, then delete the paths the
land created (they are untracked, so a `git restore -- :/` would not remove them and
would also revert your edits elsewhere). Every refusal writes nothing and names
`refs/fragua/bases/<run_id>` and the range S→P:

- `relocated_base` — the run moved its own HEAD off S, so S→P is not what you
  reviewed; land by hand from the printed `git diff <S> <P>`;
- `checkout_moved` — your HEAD moved since the capture, or a path the run changed no
  longer holds its captured content; restore it (or check out the captured HEAD) and
  retry;
- `checkout_unsafe_path` — the run changed a submodule, a fragua state path, or a
  `.gitattributes`, or wrote a path that holds something the capture never saw (an
  ignored `.env`, say); land those by hand.

A land interrupted part-way is not resumed automatically: restore the listed paths
from `refs/fragua/bases/<run_id>`. `discard` never deletes that ref; `fragua gc
--snapshots` reclaims it with the run's other refs.

Every `accept` writes `run.cwd`'s checkout, so it also refuses `checkout_busy` while
a `--checkout` run holds that checkout — including a halted or cancelled one that
awaits `fragua runs release`.

**Accepting onto the right branch.** `accept` first prints the branch and HEAD it
will land on (`target: <branch | detached> @ <short sha>`). When the run recorded a
base branch (`runs status`'s `base:`) and the checkout is on a different branch —
or detached — it refuses, writing nothing:

```
accept: run was based on <base>; current branch is <current> — pass --onto <current> or --force-branch [wrong_branch]
```

`--onto <branch>` lands on `<branch>` instead; the checkout must be on it (it is a
confirmation, not a checkout). `--force-branch` skips the check. The two cannot be
combined. A recorded base that names no branch (a sha, tag or `HEAD`) is not
checked, and a remote-tracking base such as `origin/main` is compared as `main`.

**Checkout runs are never in the inbox.** Their changes are already in the
checkout, so `accept` and `discard` refuse `not_in_inbox`:

```
run executed in checkout <path>; its changes are already there — commit them or restore with `git restore --source=<base_git_sha> --worktree -- :/`
```

**`fragua runs release <id>`** frees a terminal checkout run's hold. It is
synchronous and has no server route: it records `intent.checkout_release` and
`fact.checkout_released` together. It refuses `not_checkout_run`, `not_terminal`
(cancel the run first) and `already_released`. Release asserts that nothing is
still writing the checkout. Caveat: a run that has only just completed may still be
recording its terminal snapshot — releasing at that moment does not wait for it,
and the command says so. `unquarantine --resolution retry|treat_as_done` is refused
for a checkout run (`checkout_replay`): both replay from the start over a tree you
also own, so cancel it instead. `fragua gc --snapshots` keeps an unreleased checkout
run's refs and reclaims them once it is released.

`fragua runs status` surfaces any active soft budget warning (the 80% mark
before the hard pause); `fragua runs tail` prefixes the same event with ⚠ in
the live log. `fragua runs explain` synthesises the full narrative: path taken,
per-step outcome and cost, diff-vs-base summary, and the terminal reason.

`fragua runs wait` blocks a fleet driver until a *set* of runs settles, instead
of a hand-rolled `while fragua runs ls | grep` loop. Select the set with
explicit ids, `--workflow <name>` (every currently-active run of that workflow),
or `--all-running`. It polls the read plane (no HTTP) and prints one line per
run per lifecycle change. A run is *settled* when terminal
(completed/halted/cancelled/quarantined) or — under the default `--settle
blocked` — when blocked (paused/paused_human), since an operator wait wants to
stop the moment a run needs them; `--settle terminal` keeps polling through a
pause. `paused_auto` is never settled (the daemon owns its wake). The exit code
is the worst-outcome run's code through the shared map below — `0` when all
completed, the halt/quarantine band on a failure, `60` when any run is blocked
awaiting input — and `75` when `--timeout <dur>` expires first.

`fragua runs tail` backfills the last 200 events before going live (the bound
is a SQL-level read — long runs never hydrate the full log); pass `--full` to
replay the entire log. `fragua runs events` prints the last 50 by default;
`--limit N` keeps the last N matching events, `--all` emits the entire matching
log (overriding the default window), and `--since <seq>` keeps only events with
seq strictly greater than `<seq>` (unbounded unless `--limit` is also given — a
forward cursor for scripts). `--type <glob>` filters by event-type prefix: the
bare `fact.` prefix and the `fact.*` glob (a single trailing `*` is stripped)
are equivalent, and `fact.*` is the common forensic narrowing to state-changing
facts. The default human render closes with a `showing last N of M events —
--all for everything` footer whenever the window elided events; `--json` emits
the raw `StoredEvent[]` (and `runs messages --json` the full transcript),
drained to completion so a multi-MB log or a large assistant message survives a
pipe into `jq`. The transcript read is already unbounded, so `runs messages
--all` is accepted for symmetry but is a no-op — `runs messages` always returns
every message.

`fragua runs ls --summary` swaps the per-run list for a fleet rollup: a
status-count line (queued / running / paused\* / completed / halted / …), a
per-workflow table (`workflow | running | done | failed`), and the total cost
across non-terminal runs (the live burn — completed / cancelled / halted are
excluded). Counts and the cost SUM are SQL aggregations, not a fold over the
event log. `--status` and `--limit` scope the aggregated set the same way they
scope the list (`--limit` keeps the most-recently-updated N); `--cwd` narrows
to one project root; `--json` emits the raw rollup object. Imported runs (they
executed elsewhere) are excluded.

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
fragua harness [--port <n>] [--host <addr>] [--db <path>]   # daemon + HTTP under one supervisor (127.0.0.1:6767)
fragua serve   [--port <n>] [--host <addr>] [--cwd <dir>] [--db <path>] [--dev]   # HTTP + SSE only
fragua daemon  start [--concurrency <n>] [--provider <name>] [--model <id>] [--cwd <dir>] [--db <path>]
fragua daemon  stop                                       # SIGTERM the daemon holding the store lock
```

Server discovery is store-resident: whoever binds the HTTP listener (the
harness's in-process server, or a standalone `serve`) writes its URL into the
store's `server_endpoint` row and clears it on shutdown. `@fragua/web` reads that
row — there is no `serve.json` file and no localhost default.

`serve --dev` trusts the Vite dev origin (`http://localhost:5173`) for the
same-origin gate so `bun run dev:web` can proxy to this listener — **dev only**.
The compiled binary and `fragua harness` never trust it, so a rogue
`localhost:5173` page can't drive the unauthenticated control plane in
production. The same trust can be enabled via the `FRAGUA_DEV_ORIGIN=1` env var.
The documented dev workflow needs no manual gate step: run `fragua serve --dev`
(it prints the `FRAGUA_API_URL=<origin>/api` line), then
`FRAGUA_API_URL=<origin>/api bun run dev:web` — Vite proxies `/api/**` to the
dev-gated server. Without `--dev` the server refuses the 5173 origin with 403.

`harness` supervises the daemon subprocess: an unexpected exit — including a crash
during initial boot — is restarted with exponential backoff (500ms doubling to
30s, reset after 60s of healthy uptime), and five consecutive fast crashes stop
the harness with a non-zero exit. A hard crash leaves its `daemon_lock` row
behind (the release never runs); before respawning, the harness evicts that row
only when the holder is provably gone — its heartbeat is past the lock TTL, or
`kill(pid, 0)` reports the pid dead — so a still-live daemon (e.g. an orphan from
a SIGKILLed sibling harness) keeps its lock and single-writer holds. Readiness
gates on the replacement holding the lock under its own pid, after which the
harness stamps its own pid into the lock (`harness_pid`). The harness never
evicts its own live child; on every reaper tick (5s) it re-asserts that child's
heartbeat instead, so a child whose own tick is starved (long GC, blocked loop)
does not read as stale. The re-assert only updates a row the child still holds:
a child that lost its lock still shuts down and is respawned. `fragua daemon
stop` refuses to signal a child whose harness is alive — stop the harness
instead. On Ctrl-C the daemon
is sent SIGTERM and, if it has not stopped within 5s, SIGKILL; the wait after
SIGKILL is bounded too, so a wedged child can never hang shutdown.

---

## maintenance & authoring

```sh
fragua validate <workflow.yaml>          # parse + lint, no execution; reports tool steps using the default 5-min timeout
fragua init [--cwd <path>]               # write <cwd>/.fragua/config.yaml
fragua doctor                            # liveness: store path, daemon lock, server endpoint, providers
fragua upgrade [--to <version>]          # self-update the installed binary from GitHub Releases
fragua gc [--snapshots] [--worktrees] [--older-than 30d] [--dry-run]
fragua db vacuum                         # reclaim free pages
fragua db gc-blobs [--limit N]           # delete orphaned blob rows
fragua db backup --to <path>             # online backup to a file
fragua db migrate [--to <version>] [--dry-run] [--allow-data-loss] [--no-backup]
```

`doctor` is read-only (it never writes, evicts or clears a row) and judges
liveness from the processes and the rows together. Every pid it reports is
probed with `kill(pid, 0)`, but only when the row's hostname is this host; a
foreign-host row, or a pid owned by another user (EPERM), is taken at its word
and marked `not probed`. The `daemon:` line reads:

| Row | Process | Rendered |
|---|---|---|
| lock, fresh heartbeat | alive | `alive (Ns)` |
| lock, heartbeat past the TTL | alive | `alive, heartbeat stale Ns (host slept? the harness will respawn it)` |
| lock | gone | `dead (pid N gone; stale lock, next harness start evicts it)` |
| no lock | newest `daemon.started` pid alive | `running without a lock: pid N` |
| no lock | none | `no daemon` |

The lock's supervising harness is shown as `harness pid M`. When no daemon
process is running, a `last exit:` line follows. The `server:` line probes
`server_endpoint.pid`: `<url> alive`, `dead (pid N gone; stale endpoint)`,
`running without an endpoint row: harness pid M` (no row, but the lock's live
harness serves in-process), or `none`.

`gc` is an operator-invoked sweep over settled runs (`completed` / `halted` /
`cancelled`, not awaiting an inbox decision) older than `--older-than` (default
30d). `--snapshots` reclaims each run's worktree snapshot refs
(`refs/fragua/{snapshots,heads,bases}/<id>`). `--worktrees` removes each run's leftover
worktree directory *and* its git registration, then runs `git worktree prune` to
clear any registration whose directory was already hand-deleted — a stale
registration otherwise survives an `rm -rf` and blocks `git checkout <branch>`.
`quarantined` and `paused*` runs are never touched (their work is live or
resumable). At least one of `--snapshots` / `--worktrees` is required; both may be
combined, and `--dry-run` reports without changing anything. See
[`docs/execution-model.md`](execution-model.md) § 1 for worktree retention.

`validate` is **store-free**: it never opens `~/.fragua/fragua.db` (or any
store), so it works in CI and editor contexts with no DB present. Model ids
are checked against the bundled offline pi-ai registry: a near-miss typo of a
known id (wrong separator, e.g. `claude-sonnet-5.5` for `claude-sonnet-5-5`)
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

`upgrade` replaces the currently-running fragua binary in place with the FULL
release build (web UI embedded — what `harness`/`serve` want). It resolves the
latest published tag (or `--to <version>`, which accepts `0.9.0` or `v0.9.0`),
downloads the matching `fragua-bun-<os>-<arch>` asset plus `SHA256SUMS` over
plain HTTPS, verifies the checksum fail-closed (a missing entry or digest
mismatch aborts before any replacement), then atomically swaps the executable.
The release repo is public, so no `gh` CLI and no auth are needed. It no-ops (no
download) when already on the resolved target or
newer, and refuses entirely when run from a `bun run` checkout rather than an
installed binary. A `version:` pin in `~/.fragua/config.yaml` freezes upgrades
unless `--to` is passed explicitly.

On startup `fragua harness` runs a best-effort, non-blocking check for a newer
published release and, if behind, prints one dim line
(`fragua <new> available (you're on <cur>) · run \`fragua upgrade\``). The check
never delays startup, silently does nothing on any error / timeout, and caches
its result in `~/.fragua/update-check.json`
with a ~6h TTL (so it hits the network at most ~4×/day). Set
`check_for_updates: false` in `~/.fragua/config.yaml` to disable it; a `version:`
pin or a `bun run` (dev) checkout suppresses it too.

`bash.env-passthrough: [NAME, ...]` in `.fragua/config.yaml` (merged global ⊕
project, whole-array replace) re-admits named environment variables into `bash`
tool subprocesses. By default the daemon/harness strips every variable whose
name ends in any secret-shaped suffix (`_KEY`, `_SECRET`, `_TOKEN`, `_PASSWORD`,
`_CREDENTIAL`, `_PASS`, `_AUTH`, `_PASSPHRASE`) — regardless of prefix — plus the
env-var names of providers configured in the store, so workflow shell steps
can't read the operator's keys. This is broader than provider credentials alone:
generic infra secrets like `DATABASE_PASSWORD`, `REDIS_AUTH`, or `S3_ACCESS_KEY`
are stripped too. List a non-credential var here to let it through (e.g.
`GH_TOKEN` for a `gh` step); provider credentials are never re-admitted
regardless. The passthrough list is resolved **per run** from the run's project
config merged over global, so each project served by one daemon gets its own
passthrough regardless of the daemon's launch cwd — a *different* config seam
from `bootstrap` (passthrough merges global ⊕ project; `bootstrap` is
project-only). See
`docs/execution-model.md` §2c. This is the daemon counterpart of `fragua ci
--allow-env`; `fragua ci`'s default behaviour is unchanged, though `--allow-env`
now refuses non-`_API_KEY` provider creds too (e.g. `ANTHROPIC_OAUTH_TOKEN`).

---

## Exit codes

`ci`, `run --follow`, `runs tail`, and `runs wait` all exit through the same
status+reason → code map (`packages/cli/src/cli-exit.ts` `cliExitCode`), so a
script can `case $?` on exactly how a run stopped. Codes are banded by status
class. `runs wait` reports the *worst-outcome* run in its selected set.

| Code | Meaning |
|---|---|
| `0` | `completed` — the only zero |
| `1` | couldn't run the workflow at all (not found / unparseable / bad config) |
| `10`–`18` | `halted` by reason — `error` 10, `aborted_exit` 11, `budget` 12, `occ_exhausted` 13, `timeout_exhausted` 14, `route_not_picked` 15, `route_call_not_isolated` 16, `edge_no_match` 17, `worktree_error` 18 |
| `30`–`39` | `paused` by reason — `operator` 30, `provider_error` 31, `payment_required` 32, `budget` 33, `max_retries` 34, `goal_gate` 35, `max_loops` 36, `abort_loop` 37, `provider_exhausted` 38, `engine_incompatible` 39 |
| `50`–`51` | `quarantined` — `orphan_side_effect` 50, `other` 51 |
| `60` | `paused_human` — the workflow asked a question (no responder) |
| `70` | a non-terminal status reached as a stop-state (a driver bug) |
| `75` | `runs wait --timeout` expired before every selected run settled |
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
