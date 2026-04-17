# P5.04 — `swarm serve` CLI command

## Goal
Add a `swarm serve [--port=3000]` subcommand that starts the HTTP server from
`@swarm/server` and keeps it running in the foreground with graceful shutdown
on SIGINT. Users then open a browser to the printed URL.

## Depends on
- P5.01 (`@swarm/server` scaffold + SSE)

## Scope

- Files to create:
  - `packages/cli/src/commands/serve.ts`
  - `packages/cli/test/serve.test.ts`
- Files to modify:
  - `packages/cli/bin/swarm.ts` — register the new subcommand
  - `packages/cli/package.json` — add `@swarm/server` as dep
  - `CLAUDE.md` — add a short "Running the server" section under Self-hosting
- Public API:
  - `export async function serveCommand(opts: { port?: number; runsDir?: string; cwd?: string }): Promise<number>`

## Tests

- `serveCommand({ port: 0 })` starts, binds to an ephemeral port, returns a shutdown handle
- Calling `GET /health` on the bound port returns 200
- SIGINT triggers clean shutdown (no dangling handles)
- Conflicting port → exit 1 with clear message

## Verification

- `bun run ci` passes
- Smoke: `bun run packages/cli/bin/swarm.ts serve --port 3000`, then
  `curl http://localhost:3000/health` → `{"ok":true}`
- `Ctrl-C` exits cleanly (no zombie processes)

## Out of scope

- Web UI serving (task 05 + dev server)
- Auth / HTTPS / reverse proxy configuration
- Process manager / daemonization (users can use `tmux`/`systemd`/etc.)

## Reusable patterns

- CLI wiring: mirror `packages/cli/bin/swarm.ts` existing subcommand blocks (`run`, `replay`, `providers`, `steer`, `list`)
- Option parsing: see `pick()` helper in `packages/cli/bin/swarm.ts`
- Runs dir resolution: mirror `packages/cli/src/commands/run.ts` (`opts.runsDir ?? ".swarm/runs"`, resolved against cwd)
- Hono binding: pass `createServer({ runsDir }).fetch` to `Bun.serve({ port })` or `@hono/node-server`
