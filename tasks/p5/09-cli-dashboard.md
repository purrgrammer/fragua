# P5.09 — CLI Ink TUI (`swarm dashboard`)

## Goal
Add a `swarm dashboard` subcommand that launches an Ink-based terminal UI.
Top pane: ASCII rendering of the active workflow graph with the current node
highlighted. Bottom pane: streaming text deltas + tool calls + cost ticker.
Keybind: `s` to send a steering message, `a` to abort, `q` to quit without
aborting.

## Depends on
None — independent of the server/web work. Can be built in parallel with the
web tasks and used without a server.

## Scope

- Files to create:
  - `packages/cli/src/commands/dashboard.ts`
  - `packages/cli/src/ui/AsciiGraph.tsx` — takes a `Graph` (from
    `@swarm/core`) and a `nodeStates` map, prints a simple top-down
    box layout. Reads the same data structure the web UI does — no
    DOT re-parsing, no duplicate layout logic.
  - `packages/cli/src/ui/StreamPane.tsx` — tails events, formats as chalked lines, auto-scrolls
  - `packages/cli/src/ui/CostBar.tsx`
  - `packages/cli/src/ui/KeyHandler.ts` — keypress dispatch
  - `packages/cli/test/dashboard-ascii.test.ts`
- Files to modify:
  - `packages/cli/bin/swarm.ts` — register the new subcommand
  - `packages/cli/package.json` — add `ink`, `ink-spinner`, `ink-big-text`, `react` (pinned)
- Public API:
  - `export async function dashboardCommand(opts: { runId?: string; runsDir?: string; follow?: boolean; cwd?: string }): Promise<number>`

## Tests

- `dashboard-ascii.test.ts` — snapshot of the ASCII layout for a small fixture graph (3 nodes, 1 edge)
- Event-driven highlight: feed a mock event stream, assert the rendered frame's node state matches expectations
- Key handler: `s` opens the steering prompt, `a` calls abort, `q` quits

## Verification

- `bun run ci` passes
- Smoke: `bun run packages/cli/bin/swarm.ts run workflows/build-feature.dot --input-file tasks/p5/01-server-scaffold.md &`
  then `bun run packages/cli/bin/swarm.ts dashboard --run-id <id>` in another terminal — see live progress

## Out of scope

- Full graphviz-quality layout (ASCII is fine; clickable nodes not possible in a TUI)
- Drilldown pane inside TUI (the event stream pane is enough for now)
- Mouse support

## Reusable patterns

- **Graph data structure**: `import { parseDotSource, type Graph } from "@swarm/core"` — parse the workflow DOT once, feed the resulting `Graph` straight to `AsciiGraph`. This is the same shape the web UI renders (task 06); node-state reducer (task 06's `lib/node-state.ts`) can also be reused verbatim.
- **Event tail**: the `tailJsonl` iterator in `@swarm/events` (shipped in P5.01) — same primitive the SSE route uses.
- **Cost totals**: `packages/events/src/console.ts:ConsoleSink.totals`.
- **Run id discovery**: if `--run-id` omitted, pick the newest directory in `.swarm/runs/`.
