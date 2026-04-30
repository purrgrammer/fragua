# swarm — globalization roadmap

> The plan to lift swarm from "one daemon per project directory" to "one
> harness per machine, many projects." This file is the index: it names
> the end state and points at per-subproject proposals. Companion to
> [`SPEC.md`](./SPEC.md) (current contract) and
> [`ARCHITECTURE.md`](./ARCHITECTURE.md) (current design).

## End state

- **One harness per machine** at `~/.swarm/`, supervising the daemon,
  the HTTP server, and the web UI.
- **Projects are git repositories.** Identity is a UUID committed to
  `<project>/.swarm/swarm.jsonc`; clones group by that UUID. Non-git
  ad-hoc work goes through `swarm run --ephemeral`.
- **Configuration cascades** global → project, JSONC,
  TypeBox-validated, versioned with explicit migrations.
- **Workflows resolve by name** (`@global/foo`, `@local/foo`, path) at
  the CLI/API boundary. The daemon still only sees content SHAs.
- **Worktrees isolate runs**; agents commit on `swarm/runs/<id>` so
  dispose never destroys work.
- **The file server is content-addressed git** — no filesystem walking,
  `.gitignore` honored for free.
- **Projects are emergent**, not stored: the UI lists them by
  `GROUP BY project_id` over `run_state`. SQLite remains the only
  coordination surface.

What does **not** change: the intent/fact split, projection-in-transaction,
content-addressed blobs, hard-abort semantics, the handler contract,
the event taxonomy, the ten invariants in [`SPEC.md`](./SPEC.md) §4.

## Subprojects

Most of the value of globalization is *per-project*. Subprojects below
are tagged **READY** (well-scoped, shippable on the current per-cwd
daemon) or **DESIGN** (open questions; flesh out before committing).
READY items compose forward into the harness without rework.

### READY — ship incrementally on the current model

| # | Subproject | What it lands |
|---|---|---|
| 1 | [Schema additions](./proposals/schema-additions.md) | Nullable columns on `run_state` and `events` for project_id, workflow metadata, base SHA, project_context_sha, parent_run_id |
| 2 | [Project config file](./proposals/project-config.md) | `<project>/.swarm/swarm.jsonc`, TypeBox-validated, versioned. Project scope only |
| 3 | [Local workflow resolution](./proposals/workflow-resolution.md) | `<project>/.swarm/workflows/<name>.dot`; record name/scope/path on runs |
| 4 | [Per-project DB retention](./proposals/db-retention.md) | `swarm db prune --project`, `swarm db backup --project` |
| 5 | [Run isolation via worktrees](./proposals/run-isolation.md) | Per-project worktrees, `base_git_sha`, branch-on-dispose, GC |
| 6 | [Budget controls](./proposals/budget-controls.md) | Per-project cost cap, auto-titler bound |

### DESIGN — defer until the questions resolve

| # | Subproject | Open question |
|---|---|---|
| 7 | [Harness](./proposals/harness.md) | Lifecycle, watchdog, restart-while-runs-in-flight |
| 8 | [Credentials in DB](./proposals/credentials.md) | In-process attacker threat model |
| 9 | [Project extensions](./proposals/project-extensions.md) | Trust boundary for tools/hooks; sandbox or no |
| 10 | [Rate-limit fairness](./proposals/rate-limit-fairness.md) | Per-project share algorithm |
| 11 | [Git-object file server](./proposals/file-server.md) | Worth the refactor before multi-project view exists? |
| 12 | [Migration tool](./proposals/migration.md) | Depends on harness landing |

## Sequencing principle

Each READY item composes forward without committing to the harness.
Land them in any order; #1 (schema) first because everything else
benefits from the columns.

The architectural commitment point is #7 (harness). After it, the
harness is the canonical entry point. Before it, READY items are pure
wins on the current per-cwd model.
