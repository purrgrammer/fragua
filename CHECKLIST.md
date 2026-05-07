# Open-source release checklist

Pre-publish punch list. Drop or update items as you decide.

## Polish (recommended before strangers see it)

- [ ] Web UI screenshot or asciinema cast in `README.md` under "Why you might care". The dashboard is a real selling point and the README is text-only right now.
- [ ] `CONTRIBUTING.md` — even 30 lines pointing at `AGENTS.md` ground rules + `bun run ci` workflow + branch/PR conventions. `AGENTS.md` is contributor-facing but assumes you're already inside; `CONTRIBUTING.md` is the doormat. (Punted in the readiness pass.)

## Pre-publish

- [ ] Re-run cold CI on the day of release (`rm -rf node_modules && bun install --frozen-lockfile && bun run ci`) — verified clean on 2026-05-07.
- [ ] Decide the public repo URL and owner.
- [ ] If keeping a repo URL in the web-fetch user-agent, restore it on its own commit (`packages/workspace/src/web-fetch.ts:143`). Currently generic `swarm-web-fetch/0`.
- [ ] Repo description string (~140 chars) for `gh repo create` / GitHub homepage.

## Ship

- [ ] `gh repo create <owner>/swarm --public --source=. --push`
- [ ] Optional: tag a discoverable initial release — `git tag v0.1.0 && git push --tags`. Workspace packages stay `private: true` so this is purely for users pinning a git ref.

## Decide later (npm)

- [ ] `@swarm/*` workspace scope is unclaimed on npm. Harmless while every package is `private: true`. If publishing, either claim the org or rename. Versions are all `0.0.0`.

## Flag in the announcement, not in code

These are honest design choices. Mention them up front rather than hiding them.

- Localhost-only, no auth on harness API (already called out in `STATUS.md`).
- Single SQLite, no multi-machine story.
- `parallel` branches share one worktree (read-only "deliberation only"). Tracked in [`docs/proposals/worktree-design.md`](docs/proposals/worktree-design.md).
- Bun ≥ 1.2 required. No Node-only path.

## Done in the readiness pass (2026-05-07)

For reference:

- Split capability inventory out of README into `STATUS.md`; `README.md` rewritten for first-impression (commit `0349acc`).
- New `packages/cli/README.md` with command reference; trimmed `docs/providers.md` to inference-vs-model concept.
- Deleted scratch markdown (`backlog`, `cost`, `lint`, `merge`, `top`) and the shipped one-off migration script + proposal.
- Generic web-fetch user-agent (commit `27ca811`).
- `bun run lint:docs` hoisted into GitHub Actions CI.
- `.env.example` listing supported provider env vars (commit `3c0c625`).
- Verified zero hardcoded `/Users/bandarra` paths and zero `bitrefill` references in tracked files.
- Deleted local `.swarm/swarm.db.pre-harness.*` backups (39 MB, untracked).
