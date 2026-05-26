---
title: Bundles — a portable .fragua entity that carries runs, workflows, and blobs
summary: "A `.fragua` bundle is a first-class container: one or more runs (as their raw event logs), the workflows they reference, and the content-addressed blobs they produced. A run's truth is its event log — `run_state` is a projection and is NOT bundled; it is re-derived by replaying events on import. The keystone fix this requires: the genesis event (`intent.run_enqueued`) must carry the whole run identity (project, workflow link, routing seed, contract version), because today that identity is written only to the projection row and lives nowhere in the log. Three verbs: `fragua ci --export` (write a bundle for the run it just executed), `fragua show` (validate + summarize a bundle, no store), `fragua import` (merge a bundle into a store, deriving run_state)."
status: experimental
maturity: designed
stability: experimental
last-reviewed: 2026-05-26
parent: cli-topology.md
supersedes: "db-import.md §3 (tree-state/git-bundle), §3.2 (--rehydrate), §4.1 (imported_runs marker / adopt)"
---

# Bundles

> **⚠️ Experimental.** The `.fragua` bundle format and the `ci --export` / `show`
> / `import` verbs are experimental: release-gated, off the stable surface, and
> free to change shape without a compat guarantee until promoted. `bundleVersion`
> is the change vehicle — bumps are expected and need no migration path while
> experimental. Treat a bundle as a throwaway inspection artifact, not durable
> storage. Do not wire production CI to depend on the format yet.

> Child of [`cli-topology.md`](cli-topology.md). Additive; blocks nothing.
> Consumes the artifact a CI run produces.
>
> **Supersedes the tree-state path of [`db-import.md`](db-import.md).** That
> design carried the serialized `run_state` row, packaged worktree tree-state as
> a git-bundle blob, and gated dispatch with an `imported_runs` marker cleared by
> an `adopt` verb. This proposal drops all three: `run_state` is derived (not
> carried), tree-state/resume is out of scope, and an imported run is inert *by
> construction* (no marker, no adopt). The portability audit in `db-import.md`
> §2/§4/§5 (identity collision-safety, the version gate) still holds and is
> referenced below.

## 1. What a bundle is

A `.fragua` bundle is its **own entity**, not "a serialized run." It is a
content-addressed container that can hold:

- **runs** — each as its raw **event log**, nothing more;
- **workflows** — the content-addressed workflow each run references;
- **blobs** — the bytes those runs produced (artifacts, and any spilled content).

Everything heavy is a blob (sha256-addressed, dedup'd, integrity-checked one
uniform way). Everything else is an append-only log. There is **no projection**
in a bundle — `run_state` is reconstructed on import by replaying the log.

The first shipping producer (`fragua ci --export`) writes a **single-run**
bundle (one run + its workflow + its blobs), but the format is multi-run by
construction so a future `fragua export` can pack a set.

## 2. The keystone: run identity must live in the event log

`run_state` is a projection — `foldFacts(initial, facts)` (`reducers.ts`)
replays the `fact.*` stream into status / current node / metrics / git SHAs /
inbox. **But the genesis half is missing from the log.** The synthetic genesis
event `intent.run_enqueued` carries only:

```ts
{ type: "intent.run_enqueued"; payload: { workflowSha: string; priority?: number } }
```

Every other enqueue-time identity field — `projectId`, `projectName`, the initial
`routing` (the description / auto-title seed), `contractVersion`, the advisory
`workflowName` / `workflowScope` / `workflowPath`, `scheduleId` lineage — is
written straight into the `run_state` row by `insertRunState` and is recorded
**nowhere in the event log**. So today "events are truth" (ground rule #5) is
*false* for run identity: you cannot replay a run into a complete `run_state`.

**The fix — enrich the genesis event to carry the whole run identity:**

```ts
{ type: "intent.run_enqueued"; payload: {
    workflowSha: string;
    priority?: number;
    projectId: string;
    projectName: string;
    routing: Routing;            // the enqueue seed (see the 4KB constraint below)
    contractVersion: number;
    workflowName?: string;       // advisory label; the sha is the link
    workflowScope?: string;
    workflowPath?: string;
    scheduleId?: string;         // lineage; non-FK
} }
```

Then a complete `run_state` is `foldFacts(genesisToInitialState(enqueued), facts)`:
the genesis event seeds the initial projection, the facts evolve it. Derivable
fields fall out for free — `enqueuedAt` = the genesis event `ts`; `updatedAt` =
the last event `ts`; `metrics` / `status` / `currentNode` / `*GitSha` /
`changeStat` / `inboxStatus` from the fold. **Local bindings are deliberately
NOT in the log** — `cwd`, `inboxStatus`-as-local-triage, `acceptedSha` — so they
derive to null/default on import (see §6).

This fix is worth making **independent of bundles**: it closes a real
events-are-truth gap. It is the one change here that touches the live enqueue
path.

> **Constraint — the 4KB event-payload cap.** Event payloads are capped at
> `MAX_EVENT_PAYLOAD_BYTES = 4096`; the `run_state.routing` column allows
> `MAX_ROUTING_BYTES = 8192`. The genesis event therefore carries a *tighter*
> bound on the initial `routing.input` than the row historically allowed. The
> identity scalars (a ULID `projectId`, names, an int `contractVersion`, a
> `scheduleId`) are small; `routing.input` (the free-form description) is the
> only variable field. **Decision (recommended):** bound the enqueue
> `routing.input` to fit the 4KB genesis payload and reject over-cap input at
> enqueue (a >3KB run description is pathological). The alternative — spill a
> large initial input to a blob and carry its sha in the genesis payload — is
> available if that bound ever bites, and is consistent with the blob model.

## 3. Bundle layout

A deterministic tar (manifest first), uniform with the existing `writeTar` /
`readTar` in `packages/store/src/bundle.ts`:

```
file.fragua
├── manifest.json                     # version stamps + index ONLY — no projections
├── runs/<id>/events.jsonl            # the run's event log (genesis + facts), one event per line
├── runs/<id>/messages.jsonl          # the transcript, one message per line (see §5)
├── workflows/<sha>/source.yaml       # the workflow as authored
├── workflows/<sha>/ir.json           # its compiled IR (the sha is an IR hash — workflow-ir.md)
└── blobs/<sha256>                    # content-addressed bytes (artifacts, + spilled content)
```

`manifest.json` is a pure index — it names what's inside and stamps versions; it
holds **no** `run_state`, no derived counts:

```ts
interface BundleManifest {
  bundleVersion: number;          // hard import gate
  fraguaVersion: string;          // provenance
  contractVersion: number;        // event-contract version — reported, not gated on import (§7)
  schemaVersion: number;
  irVersion: number;
  runs: { runId: string; workflowSha: string; events: number; messages: number }[];
  workflows: { sha: string; name: string }[];
  blobs: { sha256: string; size: number }[];
}
```

## 4. The three verbs

> All three are **release-gated** behind the experimental flag (the gate
> `ci --export` already sits behind on this branch). They are hidden from the
> stable `--help` surface and may change until the format is promoted.

### `fragua ci --export <file.fragua>`

`ci` already embeds the executor over an ephemeral store and runs one workflow
to terminal. On terminal, serialize that single run into a bundle: its
`events.jsonl` + `messages.jsonl`, the one `workflows/<sha>/`, and every blob the
run references. Secret-free by construction — provider tables are never walked.
This is the artifact CI uploads. (Replaces the `--db` raw-store artifact and the
prior `--bundle` flag; the bundle is the portable thing.)

### `fragua show <file.fragua>`

Validate and summarize a bundle **without any store** (read-only, no `--db`):

1. Structural: manifest present + parseable, `bundleVersion` supported, every
   `runs/*/events.jsonl` and referenced `workflows/<sha>/` present.
2. Integrity: every `blobs/<sha256>` hashes to its name; every manifest blob
   entry present.
3. Summary per run: **replay `events.jsonl`** → status / outcome, node count,
   cost + tokens (from `metrics`), duration (last ts − genesis ts), `#messages`
   and `#artifacts` (countable straight from the `fact.message_appended` /
   artifact events — no need to open message bodies or blobs).

`show` is the human entry point: "what's in this file, is it intact, what
happened in the run."

### `fragua import <file.fragua> [--db <target>]`

Merge a bundle into an **existing** store (default: the harness store); a
`migrate:false` store-client like every other verb — never creates or migrates a
store. Per run, in one write transaction (I1 — serialize + write blob files
*before* the txn; pure SQL inside):

1. Insert `workflows/<sha>/` (dedup by sha) and `blobs/<sha256>` (dedup by sha).
2. Insert `events.jsonl` verbatim (`INSERT OR IGNORE` on `(run_id, seq)` — idempotent).
3. **Derive `run_state`**: `foldFacts(genesisToInitialState(enqueued), facts)` →
   write the projection. No carried row to scrub.
4. Reconstitute messages from `messages.jsonl` (§5).

Idempotent: re-importing is a no-op (content-addressed dedup + PK skip). Lands
the run at its **derived** status; for a `ci --export` run that is always
terminal (completed / failed / halted), so it is never a dispatch candidate.

> `runs status|events|messages|steps|artifacts <id> --db <target>` then resolve
> against the imported run. `runs diff` does **not** — tree-state is out of scope
> (§8).

## 5. Messages — shipped inline now, blob-derived later

Message **content** is *not* derivable from the event log: `fact.message_appended`
carries only `{ ordinal, role, nodeId, iteration }` (a pointer), because content
runs to `MAX_MESSAGE_CONTENT_BYTES = 1 MiB` and cannot fit the 4KB event payload.
The transcript is primary data, not a projection — so the bundle must carry it.

**v1 — inline.** `runs/<id>/messages.jsonl`, one row per line
(`{ ordinal, role, nodeId, iteration, content }`); import inserts directly. This
is simple, correct, and unblocks `ci --export`. Shipping the transcript as its
own stream is *not* the smell that shipping `run_state` was — it is truth.

**North star (own proposal, NOT here) — content-as-blobs.** Enrich
`fact.message_appended` with a `contentSha`, spill content to the blob store at
write time, and messages derive from `(events + blobs)` exactly as `run_state`
derives from `(genesis + facts)`. The bundle then collapses to **events +
workflows + blobs** with no `messages.jsonl` — the symmetric counterpart to the
§2 genesis fix. Its cost is real and store-wide (the live `appendMessage` path,
likely a `messages` schema change from inline `TEXT` to a blob ref, and a blob
fetch on every transcript read), so it is a deliberate later decision, not a
bundle-format hack. The intermediate "pointer file + content blobs, keep
`messages.jsonl`" is explicitly **rejected** — it costs nearly as much as the
north star while still leaving a pointer file between the log and the blobs.

## 6. Inertness is free — no marker, no adopt

`db-import.md` needed an `imported_runs` table and an `adopt` verb to keep an
imported run out of dispatch while showing its status verbatim. That apparatus
is **unnecessary here**: `cwd` is a local binding and is not in the event log, so
a derived `run_state` has `cwd = null`. The worktree provisioner already refuses
a `cwd`-less run (it no longer falls back to the daemon's own dir). A
`cwd = null` run therefore cannot be claimed or provisioned — **inert by
construction.** The three mismatched primitives (import / `--rehydrate` /
`adopt`) collapse to: a bundle is data; you `import` it, you `show` it.

(Resume of an imported run — which *would* need a worktree, hence `cwd`, hence
tree-state — is out of scope, §8. The day it returns it brings its own explicit
verb; it does not resurrect the marker.)

## 7. Version & integrity gates

- **Hard reject on import:** unsupported `bundleVersion`; any blob absent or
  failing its sha256; FK closure is enforced by the import transaction
  (`PRAGMA foreign_keys = ON`), not pre-validated.
- **Reported, not gated:** the event-contract version. A bundle from a newer or
  older engine still imports for inspection; only *resume* (out of scope) would
  gate on it (`db-import.md` §5, [`event-contract-version.md`](event-contract-version.md)).
- **Determinism:** canonical JSON (sorted keys) + canonical ordering (events by
  seq, messages by ordinal, blobs by sha, workflows by sha) so re-export is
  byte-identical across stores.

## 8. Scope

- **In:** the §2 genesis enrichment; the §3 bundle format; `ci --export`,
  `show`, `import`; derive `run_state` on import; inline messages (§5 v1).
- **Out (deferred):** worktree/tree-state, `runs diff` on an imported run, and
  resume of an imported run — all need git objects the bundle no longer carries.
  Message content-as-blobs (§5 north star) is its own proposal. Multi-run
  `fragua export` (the format supports it; no producer ships it yet).
- **Removed from the `run-bundle-import` branch:** the git-bundle export
  (`run-bundle-git.ts`, `buildRunGitBundle`, `rehydrateRunWorktree`),
  `runs import --rehydrate` / `--into`, `runs adopt`, the `imported_runs` table
  and its dispatch/concurrency gating, `setRunCwd` / `isRunImported` /
  `adoptRun`, and the manifest's serialized `run_state`.

## 9. Migration of the existing branch

The `run-bundle-import` branch shipped the carry-`run_state` + tree-state +
adopt model. Re-shaping to this spec is mostly subtraction plus the one additive
keystone:

1. **Add** the genesis-event enrichment (§2) — the only live-path change; update
   the `intent.run_enqueued` payload type, the enqueue writer, and a
   `genesisToInitialState` reducer seed. Grep `intent.run_enqueued` consumers.
2. **Reshape** the manifest (§3): drop `run`/`run_state`; index `runs[]` /
   `workflows[]` / `blobs[]`; move events + messages to per-run `*.jsonl`.
3. **Rewrite** `importRunBundle` to derive `run_state` (§4 step 3) instead of
   `insertRunState` + `writeRunStateProjection` from a carried row.
4. **Delete** the git-bundle + rehydrate + adopt + `imported_runs` surface (§8).
5. **Re-wire** the CLI: `fragua import` / `fragua show` as bundle-level verbs;
   `ci --export` writes the new format. (`runs export` of a single existing run
   stays available as the manual counterpart to `ci --export`.)
