# Open-source release checklist

Pre-publish punch list. Drop or update items as you decide.

- [ ] YAML authoring format 
- [ ] YAML cleanup
- [ ] JSON IR, versioned workflows by sha
- [ ] Sample workflows
- [ ] Worktrees
- [ ] Collapse migrations
- [ ] Rename to fragua
 + [ ] Skills pass & rename
- [ ] E2E onboarding
- [ ] CONTRIBUTING.md
- [ ] README.md
  + [ ] Screenshots
- [ ] Demo video and writeup

## Polish (recommended before strangers see it)

- [ ] Web UI screenshot or asciinema cast in `README.md` under "Why you might care". The dashboard is a real selling point and the README is text-only right now.

## Pre-publish

- [ ] Re-run cold CI on the day of release (`rm -rf node_modules && bun install --frozen-lockfile && bun run ci`)
- [ ] Repo description string (~140 chars) for `gh repo create` / GitHub homepage.

## Ship

- [ ] `gh repo create <owner>/swarm --public --source=. --push`
- [ ] Optional: tag a discoverable initial release — `git tag v0.1.0 && git push --tags`. Workspace packages stay `private: true` so this is purely for users pinning a git ref.

## Decide later (npm)

- [ ] `@fragua/*` workspace scope is unclaimed on npm. Harmless while every package is `private: true`. If publishing, either claim the org or rename. Versions are all `0.0.0`.
