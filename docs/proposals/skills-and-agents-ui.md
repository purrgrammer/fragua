---
title: Skills + agents — web UI surface and unified discovery
summary: "Skills + agents discovery UI plus unified discovery across globals and every known project cwd"
status: shipped
maturity: specified
last-reviewed: 2026-05-05
---

# Skills + agents — web UI surface and unified discovery

> Today, skills and agents are discovered exactly once at daemon boot,
> against a single cwd (the daemon's startup directory). They surface
> nowhere in the web UI. This proposal adds two top-level web sections
> (Skills, Agents) with list + detail views, file-tree exploration on
> skill detail, prompt-body rendering on agent detail, and reorients
> discovery so both the daemon and the server walk the same dirs:
> globals plus every cwd in `run_state`. A run sees only its own
> project's slice; the UI sees the unfiltered superset.

## Goals

- Top-level web routes `/skills` + `/agents` with list + detail.
- Per-project nesting at `/projects/:id/skills` + `/projects/:id/agents`,
  reusing the same components against a project-filtered query.
- Skill detail shows metadata header + recursive file-tree + lazy
  on-demand file viewer; SKILL.md auto-selected on open. Markdown
  rendered with a raw toggle. Images inline; other binary as
  hex-dump.
- Agent detail shows metadata header + the prompt body (the markdown
  the sub-agent receives verbatim).
- Discovery model unified across daemon and server: globals
  (`~/.agents`, `~/.claude`) **plus** every cwd in
  `IEventStore.listCwds()`. The daemon's catalogue becomes a superset
  filtered per-run by `run.cwd`; the server walks the same dirs on
  demand to back the UI.
- Auto-scan on first sight: when a run starts in a cwd not yet in the
  daemon's known-project set, incremental discovery for just that cwd
  runs before dispatch. New projects' first runs see their own
  project-scope skills without restart.
- Read-only UI. Manual refresh only — no FS watcher, no auto-refresh.
- Server holds no catalogue state. Each `/skills` / `/agents` request
  re-walks. Client-side `tanstack-query` caches list + tree +
  per-file content; the rescan button invalidates.

## Non-goals

- Editing skills/agents from the UI. Read + browse only.
- Hot reload on FS change. Boot-time + auto-scan-on-first-sight +
  manual refresh covers the realistic cases; FS watching is deferred.
- Per-node skill filtering UI (the existing DOT-attribute
  `skills=<allowlist>` mechanism on workflow nodes is unchanged and
  not surfaced here).
- A unified daemon-and-server catalogue object. The two have
  different lifecycles (boot-time vs request-time) and different
  consumers (codergen vs UI); keeping them as separate slices of the
  same discovery code is the simpler model.
- A `POST /skills/rescan` endpoint. Server is stateless; rescan is
  pure client refetch via `queryClient.invalidateQueries`.

## Two catalogues, one discovery

Today the daemon scans `~/.agents`, `~/.claude`, plus its **own
startup cwd's** `.agents` / `.claude`. A run in project B sees project
A's skills if the daemon was launched in A. The fix is to widen the
walked set, not change ownership.

After this proposal, both the daemon and the server walk:

```
~/.agents/skills/   ~/.claude/skills/
~/.agents/agents/   ~/.claude/agents/

for cwd in store.listCwds():
  <cwd>/.agents/skills/   <cwd>/.claude/skills/
  <cwd>/.agents/agents/   <cwd>/.claude/agents/
```

Each discovered record gains a `project_cwd` field (set only when
`scope === "project"`). Within a single project cwd, `.agents` beats
`.claude` on name collision. Across projects, skill-name collisions
are kept (different `project_cwd` rows); they only collapse at
codergen time when the per-run filter prunes to one project.

**Daemon**: scans at boot, holds the superset in memory. At codergen
dispatch — at the seam where `PiCodergenBackend` is constructed —
filters to `scope === "user" || project_cwd === run.cwd` before
populating `this.skills` and `this.agentDefinitions`. The agent
backend's existing `filterSkillsForNode` (per-node DOT-attribute
allowlist) runs on top of that pre-filtered slice unchanged.

**Server**: scans per request. Cost is frontmatter-only reads,
millisecond-scale for realistic project counts. No server-side
cache; `tanstack-query` holds the result client-side with manual
invalidation.

**First-run-in-new-project**: when the daemon dispatcher prepares a
codergen call and `run.cwd` is not in its known-project set, an
incremental scan of just that cwd runs and merges into the in-memory
catalogue before dispatch. Guarded with an inflight `Set<string>` so
two concurrent dispatches in a never-seen cwd don't double-scan.
Existing-project edits still require a daemon restart (or a
deliberate rescan path, deferred).

## Identity in URLs

Skill names aren't globally unique (a `frontend` skill can exist in
project A and project B as different files on disk). The detail URL
keys on the location:

- Skills: `:locId = base64url(skill_dir)`
- Agents: `:locId = base64url(location)` (single-file profiles)

Round-trip stable, opaque to the UI, no leakage of cwd structure
beyond the encoded blob. Names remain the human-friendly column in
list views.

## Endpoint shape

```
GET /skills
  → [{ name, description, scope, source_dir, project_cwd?,
       sha256, bytes, compatibility?, disabled_reason? }, …]
  → ?project_cwd=<cwd> filters to globals ∪ that one cwd

GET /skills/:locId
  → metadata + parsed frontmatter + body of SKILL.md

GET /skills/:locId/tree
  → recursive walk under skill_dir
  → [{ path, type: "file"|"dir", size }, …] (paths relative to skill_dir)

GET /skills/:locId/file?path=<relPath>
  → raw bytes with Content-Type from extension
  → sandboxed: path.resolve(skill_dir, p) must remain under skill_dir + sep

GET /agents
  → [{ name, description, scope, source_dir, project_cwd?,
       model?, provider?, allowed_tools?, sha256, bytes, disabled_reason? }, …]
  → ?project_cwd=<cwd> filter as above

GET /agents/:locId
  → metadata + body (the prompt the sub-agent receives verbatim)
```

`tree` and `file` endpoints exist only for skills (skills are
directories with auxiliary files); agents are single-file.

## URL structure in the web UI

```
/skills                      global list (all scopes, all known projects)
/skills/:locId               detail (metadata header + tree + viewer)
/agents                      global list
/agents/:locId               detail (metadata header + prompt body)

/projects/:id/skills         project-filtered list
/projects/:id/agents         project-filtered list
```

Same list/detail components in both placements, parameterised by the
backing query.

## File viewer dispatch

On the right pane of skill detail, the viewer chooses by extension:

- `.md` — markdown rendered, with a raw/rendered toggle. SKILL.md
  auto-selected on open.
- `.png` / `.jpg` / `.jpeg` / `.gif` / `.svg` / `.webp` — inline
  `<img>`.
- Text-ish (`.py` / `.sh` / `.js` / `.ts` / `.txt` / `.json` / `.yml`
  / `.yaml` / `.toml` / `.html` / `.css`) — monospace text.
- Everything else — hex-dump (16 bytes per row, ASCII gutter, capped
  at ~4 KB with a "show more" affordance).

## Type extensions

- `Skill.project_cwd?: string` (set only when `scope === "project"`).
- `AgentDefinition.project_cwd?: string` (same).
- `SkillCatalogRecord.project_cwd?: string` — emitted on
  `llm.start.skills[]`, so replay can correlate environment-mismatch
  outcomes against which project's skills were active.

The `SkillCatalogRecord` change is a contract-surface change and
requires the same-PR `docs/ARCHITECTURE.md` §3 update per AGENTS.md
ground rule #1.

## Implementation slices

**Slice 1 — discovery model unification (foundation, breaking):**

1. Type extensions in `@swarm/types` (skills, agents, catalog
   record).
2. `discoverSkills` / `discoverAgents` signatures change from `cwd:
   string` to `projectCwds: string[]`. Callers stamp `project_cwd`
   on each project-scope record.
3. Daemon boot reads `store.listCwds()` and passes the cwd list into
   discovery.
4. Codergen dispatch filters the catalogue by `run.cwd` before
   constructing `PiCodergenBackend` (`packages/agent/src/backend.ts`
   stays catalogue-agnostic).
5. Auto-scan-on-first-sight in the dispatcher when `run.cwd` is
   unknown.
6. ARCH §3 update for the new `SkillCatalogRecord.project_cwd`
   field.
7. Tests: multi-project superset, per-run filtering, auto-scan
   merge-and-skip-on-second-call, signature migration of existing
   single-cwd tests.

**Slice 2 — server endpoints:**

1. `@swarm/server` adds `@swarm/workspace` as a dep (no cycle —
   workspace depends on core/types only).
2. New `packages/server/src/store/skills-routes.ts` and
   `agents-routes.ts`. Mounted in `index.ts`.
3. `?project_cwd=<cwd>` query filter on list endpoints.
4. Sandbox `file?path=` against `skill_dir` (no `..` escape).
5. ARCH §7 update: list new operator routes.
6. Route tests including b64url round-trip and sandbox rejection.

**Slice 3 — web UI, global views:**

1. `queries.skills.{list,detail,tree,file}` and
   `queries.agents.{list,detail}` factories in `web/src/lib/queries.ts`.
2. New routes: `Skills.tsx`, `SkillDetail.tsx`, `Agents.tsx`,
   `AgentDetail.tsx`.
3. Reusable `file-tree.tsx` and `file-viewer.tsx` components.
4. Sidebar entries for Skills + Agents at top level.
5. Markdown renderer reused from `ai-elements`; raw toggle.
6. Component tests for list rendering, detail open with auto-selected
   SKILL.md, viewer mode dispatch.

**Slice 4 — per-project nesting:**

1. `/projects/:id/skills` + `/projects/:id/agents` mounted under
   `ProjectDetail.tsx` as tabs.
2. Same components as Slice 3, parameterised by the filtered query
   (passing `project_cwd` to the server).
3. Tests: per-project list excludes other projects' rows; user-scope
   skills always present.

Slice 1 is the load-bearing change and must land first. Slices 2–4
are mechanical once the discovery shape is fixed.

## Risks

- **Catalogue divergence between daemon and server.** The daemon
  scans at boot; the server scans per request. A skill added between
  daemon boot and a UI rescan will appear in the UI but be invisible
  to codergen until the daemon restarts (or a future deliberate
  rescan path lands). Acceptable for v1 — surfaced as a known
  limitation.
- **`base64url(path)` URL length.** Realistic skill paths under
  `/Users/<user>/<project>/.agents/skills/<name>` encode to ~150–300
  bytes. Well within URL limits; not a concern.
- **Project list churn.** `store.listCwds()` returns every cwd that
  has ever had a run. Long-lived databases will accumulate stale
  cwds where the project directory no longer exists on disk.
  Discovery must silently skip non-existent paths. The "stale cwd
  cleanup" question is orthogonal and out of scope here.
- **Auto-scan-on-first-sight latency.** First codergen call for a
  new project pays one frontmatter walk of `<cwd>/.agents/skills/`
  + `<cwd>/.claude/skills/` (and same for agents). Bounded by the
  number of skills in those dirs; expected ms-scale.
