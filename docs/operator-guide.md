# Operator guide — driving a run that pauses for input

This is a human walkthrough of the **human-in-the-loop (HITL) lifecycle**: how to start
a run, answer it when it pauses for your decision, and land or drop the result. Every
step is a `fragua` CLI verb (or its equivalent in the web UI on `:6767`).

If you're an agent steering runs programmatically, the `operate` skill
(`.agents/skills/operate/SKILL.md`) is the machine-facing version with the full verb
table; this guide is the prose path for a person at a terminal.

Prerequisites: a provider credential (`fragua providers add`) and a running harness
(`fragua harness`) so queued runs actually execute. The CLI reads and writes the store
directly, so the read/inspect verbs work even with the harness down — but a run only
*makes progress* while the harness is up.

---

## The lifecycle at a glance

```
fragua run <wf>          → run is queued, then running
   ↓  (hits a `human` node)
paused_human             → run is waiting for you
   ↓  fragua runs inbox  (find it)
   ↓  fragua runs respond <id> <route>
running → completed      → run resumes and finishes
   ↓  fragua runs accept|discard <id>
landed (or dropped)
```

A run's **lifecycle status** is one of `queued`, `running`, `paused`, `paused_human`,
`paused_auto`, `completed`, `cancelled`, `halted`, `quarantined`. This guide touches the
happy HITL path: `running → paused_human → running → completed`.

---

## 1. Start the run — `fragua run`

```sh
fragua run <workflow> --input name=value
```

`fragua run` saves the workflow, enqueues it, and follows its event log in your terminal
until the run reaches a terminal or paused state. A bare workflow name resolves under
`~/.fragua/workflows/` first, then `<cwd>/.fragua/workflows/`; a path ending in `.yaml`
is taken literally. Repeat `--input name=value` for each typed input the workflow
declares.

When the run reaches a `human` node, it enters **`paused_human`** and waits for your
decision. If you're still following on a terminal, `fragua run` shows the choice picker
inline — answer it and it keeps following. If you detached (`--no-follow`) or the follow
exited, pick the run back up from the inbox below.

---

## 2. Find the waiting run — `fragua runs inbox`

```sh
fragua runs inbox
```

The inbox is your worklist. It has two sections:

- **NEEDS INPUT** — runs that are blocked waiting on you: a `paused_human` HITL gate, an
  operator-resumable `paused` run, or a `quarantined` orphan.
- **READY TO LAND** — terminal runs that left recoverable work, with a diffstat.

A `paused_human` run shows up under **NEEDS INPUT** with its run id and the routes it's
waiting on. To see the full picture for one run:

```sh
fragua runs status <id>
```

`status` prints the run's lifecycle and outcome plus *why* it's where it is — for a
HITL pause, that includes the gate's prompt and the list of allowed routes.

---

## 3. Answer the gate — `fragua runs respond`

```sh
fragua runs respond <id> <route>        # answer directly (scriptable)
fragua runs respond <id>                # arrow-key menu of the gate's routes
```

The `<route>` must be one of the gate's declared options — the CLI rejects an off-list
route. Run `fragua runs respond <id>` with no route to get an interactive menu of the
human-readable labels and pick one.

Once you respond, the run leaves `paused_human`, re-queues, and the harness resumes it.
It runs to its terminal state — typically **`completed`** for the happy path (or
`halted` / `cancelled` if something later goes wrong). Watch it land:

```sh
fragua runs tail <id>      # follow the live event log to terminal
fragua runs status <id>    # one-shot snapshot
```

---

## 4. Land or drop the result — `fragua runs accept` / `discard`

A `completed` run that produced agent work (commits in its worktree) shows under
**READY TO LAND** in the inbox. Review it, then keep it or throw it away:

```sh
fragua runs diff <id>      # review the change first
fragua runs accept <id>    # replay the run's commits onto your current branch + stage the tail
fragua runs discard <id>   # drop the run's refs (final)
```

`accept` runs synchronously and replays the run's commits onto `HEAD` in the run's
working directory, then stages any uncommitted tail for you to `git commit`. It refuses
(non-zero exit, with a reason) if the change doesn't merge cleanly (`conflict`), your
tree has uncommitted changes (`dirty_tree` — stash or commit first), or there's nothing
to land (`no_work`).

`discard` drops the run's snapshot/head refs and is final — a later `accept` or
`discard` on a discarded run exits non-zero.

---

## The web UI equivalent (`:6767`)

`fragua harness` serves a web dashboard on `:6767`. Everything above has a GUI
equivalent:

- The dashboard's **inbox** mirrors `fragua runs inbox` — the same NEEDS INPUT / READY
  TO LAND split.
- A `paused_human` run renders its gate with the route options as buttons; clicking one
  is the same as `fragua runs respond <id> <route>`.
- A finished run exposes its diff and **accept** / **discard** controls, equivalent to
  the CLI verbs.

Use whichever surface you prefer — both write through the same store, so a run answered
in the UI is immediately visible to the CLI and vice versa.

---

## See also

- **[docs/cli.md](cli.md)** — every `fragua` verb, flag, and exit code.
- **[docs/SPEC.md](SPEC.md)** — what fragua is and its invariants.
- `.agents/skills/operate/SKILL.md` — the agent-facing operate skill (full control-plane
  verb table, quarantine resolution, forensics).
