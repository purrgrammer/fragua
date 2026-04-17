# P5 — Observability surface (task backlog)

Each file in this directory is a self-contained feature spec meant to be fed to
the self-hosting workflow as a single `swarm run` invocation:

```sh
bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot \
  --input-file tasks/p5/01-server-scaffold.md \
  --worktree
```

Batch (recommended for a review cadence — one task, review, merge, next):

```sh
for f in tasks/p5/0*.md; do
  echo "▶ $f"
  bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot \
    --input-file "$f" --worktree
done
```

## Goal of P5

Ship the UI humans actually use: HTTP server with SSE event stream, React web
UI (Graphviz-wasm SVG + Vercel AI Elements drilldown + cost panel), and an Ink
TUI. See `docs/PLAN.md` Phase 5 for the full scope.

## Status table

Update this table after each task merges. `run_id` is printed by `swarm run`;
`merged_in` is the short SHA of the squash-merge commit to main.

| #  | Title                                   | Depends        | Status  | run_id | merged_in |
|----|-----------------------------------------|----------------|---------|--------|-----------|
| 01 | @swarm/server scaffold + SSE events     | —              | merged  | 1776427940185-izjn3k | 163a378   |
| 02 | Server REST: pipelines CRUD             | 01             | merged (variant; POST/DELETE launcher still open) | 1776441042341-o8z8ac | 35baa10   |
| 03 | Server: graph SVG + interview endpoints | 02             | merged (delivered alongside 02) | 1776441042341-o8z8ac | 35baa10   |
| 04 | `swarm serve` CLI command               | 01             | merged  | (manual) | b754cba   |
| 05 | @swarm/web scaffold (Vite/React/Tailwind)| 01            | pending |        |           |
| 06 | Web: graph view + active-node highlight | 05, 02         | pending |        |           |
| 07 | Web: event timeline + filter + cost     | 05, 01         | pending |        |           |
| 08 | Web: step drilldown (AI Elements)       | 07             | pending |        |           |
| 09 | CLI Ink TUI (`swarm dashboard`)         | —              | pending |        |           |
| 10 | `swarm replay` feeds TUI + web          | 09, 06         | pending |        |           |
| 11 | Visual regression + cost reconciliation | 06, 07, 08     | pending |        |           |

## Task file template

All specs follow the same structure so the `explore` stage of
`build-feature.dot` can parse them consistently:

```markdown
# P5.NN — <short title>

## Goal
<1-3 sentences>

## Depends on
<earlier P5.NN tasks, or "none">

## Scope
- Files to create: ...
- Files to modify: ...
- Public API additions: ...

## Tests
- <test path>: <what it verifies>

## Verification
- `bun run ci` passes
- <manual smoke step>

## Out of scope
- <explicit non-goals>
```

## Design principles

- **Data-first, always.** The server exposes typed JSON; clients (web, TUI,
  replay, future adapters) render from data. We never server-render SVG or
  any other display format — the `Graph` shape from `@swarm/core` is the
  contract, and that shape is serializable, diffable, and typeable.
- **One parser, two runtimes.** `@swarm/core` is pure (no `node:` imports)
  so `parseDotSource` runs both server-side and in the browser bundle.
  Tasks that need a `Graph` import it from `@swarm/core` — no DOT parsing
  duplication.
- **Render libraries are replaceable, data isn't.** If AI Elements ships a
  workflow primitive that fits, use it. If not, reach for React Flow,
  elkjs, or plain SVG. None of that leaks into the data layer.

## Reusable patterns

When writing a new task spec, point the agent at these existing primitives
instead of letting it rebuild them:

- **Graph type + parser** — `import { parseDotSource, type Graph, type Node, type Edge } from "@swarm/core"` (pure, browser-safe)
- **Events** — `packages/core/src/types/events.ts` defines all 28 event types
- **Event tail** — `@swarm/events` `tailJsonl` (shipped in P5.01, handles truncation)
- **JSONL sink** — `packages/events/src/jsonl.ts:JsonlSink` (atomic append, mkdir parent)
- **Cost totals** — `packages/events/src/console.ts:ConsoleSink.totals` (aggregated per run)
- **Provider checks** — `packages/agent/src/providers.ts:hasProviderCredentials`
- **Runs layout** — `.swarm/runs/<id>/{events.jsonl, summary.md, steering.jsonl, checkpoint.json}`

## Tips for running

- Use `--worktree` so each run lives on its own `swarm/<run-id>` branch — your
  main checkout stays clean.
- Use `--keep-worktree` while iterating on a spec that needs human tweaks.
- Review the diff with `git checkout swarm/<run-id> && bun run ci` before
  merging. Squash-merge into main with the task id in the subject.
- If a run gets stuck on the wrong approach, `swarm steer <run-id> "<correction>"`
  before killing it.
