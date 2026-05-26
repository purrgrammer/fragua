# Bundles — implementation plan

> Executes [`bundles.md`](bundles.md). Reshapes the `run-bundle-import` branch
> from the carry-`run_state` + tree-state + adopt model to: bundle = entity
> (runs-as-event-logs + workflows + blobs), `run_state` derived on import,
> tree-state/adopt dropped. **Experimental** — release-gated, `bundleVersion`
> bumps freely.
>
> Ground rules (CLAUDE.md): branch only, no `main` pushes; commit when asked;
> `bun test` + `bun run typecheck` + `bun run lint` green per phase; **I1 — no
> `await` / `JSON.stringify` / I/O inside `db.transaction(...)`** (serialize +
> write blob files first); enum-literal consumers grepped on any union change.
>
> Phases are independently shippable and ordered by dependency. Phase 0 is the
> keystone and wins on its own (closes an events-are-truth gap); everything else
> depends on it.

## Phase 0 — Genesis identity in the event log (keystone, live-path)

**Goal:** a complete `run_state` is derivable by replaying a run's events. The
only change to the live enqueue path.

- `packages/types/src/events.ts:265` — widen the `intent.run_enqueued` payload
  from `{ workflowSha; priority? }` to carry the whole identity:
  `projectId, projectName, routing, contractVersion, workflowName?,
  workflowScope?, workflowPath?, scheduleId?` (mirror the `insertRunState`
  arg set, minus the local bindings `cwd` / `inbox` / `acceptedSha`).
- `packages/store/src/store.ts:595` (`enqueueRun`) — serialize all of those into
  the genesis payload. **Every field is already in scope** at line 575–592; this
  is moving data that exists, not plumbing new params. **Do NOT include `cwd`** —
  its absence from the log is what makes an imported run inert by construction
  (`bundles.md` §6).
- **4KB guard (the §2 constraint).** The genesis payload must fit
  `MAX_EVENT_PAYLOAD_BYTES = 4096`, tighter than `run_state.routing`'s 8192. Add
  a guard on the serialized genesis payload in `enqueueRun`; on over-cap, throw a
  clear "run input/description too long" error (the dominant variable is
  `routing.input`). Keep `workflowPath` advisory and short. **Decision baked in:**
  bound + reject (not spill-to-blob) — revisit only if it bites.
- `packages/store/src/reducers.ts` — add `genesisToInitialState(payload, ts):
  RunState`: status `"queued"`, `currentNode: null`, `enqueuedAt = ts`,
  `readyAt = ts`, `metrics: emptyMetrics()`, `cwd: null`, `nextSeq`/`version`
  seeded, identity from the payload. This is the seed `foldFacts` folds onto.
- `packages/core/src/handler/intent-fold.ts:224` already no-ops `run_enqueued`
  (projection-level) — confirm the wider payload doesn't break it.

**Grep before done:** `intent.run_enqueued` consumers — `supervisor.ts:50`,
`executor.ts:505`, `intent-fold.ts:224` — none should read the new fields, but
confirm none assume the slim shape.

**Test (this is the foundational correctness gate):** enqueue a run, run it to
terminal in a test executor, then assert
`foldFacts(genesisToInitialState(enqueued, ts), facts) ` deep-equals the live
`getState(runId)` **modulo local bindings** (`cwd`, `inboxStatus`-as-triage,
`acceptedSha`). If that holds, import-by-derivation is sound.

> Pre-release (ground rule #11): runs enqueued *before* this phase carry the slim
> genesis payload and won't fully derive — acceptable, and bundles are
> experimental. No back-compat shim.

## Phase 1 — Bundle format (manifest + layout)

- `packages/store/src/bundle.ts` — keep `writeTar` / `readTar`. Bump
  `BUNDLE_VERSION`. Replace `BundleManifest` with the index-only shape
  (`bundles.md` §3): `runs[] / workflows[] / blobs[]` + version stamps, **no
  `run` / `run_state`**.
- Add path-builder constants/helpers: `runs/<id>/events.jsonl`,
  `runs/<id>/messages.jsonl`, `workflows/<sha>/source.yaml`,
  `workflows/<sha>/ir.json`, `blobs/<sha256>`.
- A small jsonl encode/decode helper (newline-delimited canonical JSON).

**Test:** `writeTar`→`readTar` round-trip of the new entry set; manifest shape.

## Phase 2 — Export (`exportRunBundle` rewrite) + `ci --export`

- `packages/store/src/store.ts` — rewrite `exportRunBundle(runId,
  { fraguaVersion })`: gather `events` → `events.jsonl`; `messages` → inline
  `messages.jsonl` (§5 v1); the one `workflows/<sha>/{source,ir}`; the
  artifact-referenced `blobs/<sha>`. Build the index manifest. **Drop** the
  `gitBundle` param and the run_state serialization. Canonical ordering (events
  by seq, messages by ordinal, blobs/workflows by sha) for re-export
  determinism.
- `packages/cli/src/commands/ci.ts` + `bin/fragua.ts` — `--export` already wired
  on this branch; point it at the new format. Keep it release-gated.

**Test:** export a seeded+executed run → `readTar` → assert: manifest carries no
projection, `events.jsonl` line count == event count, blobs present and hash,
workflow source+ir present.

## Phase 3 — Import (`importRunBundle` rewrite, derive run_state)

- `packages/store/src/store.ts:1531` area — rewrite `importRunBundle(bytes)`:
  1. `readTar` → manifest → validate `bundleVersion` (hard reject); every blob
     present + hashes to its sha (hard reject).
  2. **Serialize + write blob files BEFORE the txn** (I1). Pre-`JSON.parse` each
     events.jsonl / messages.jsonl line outside the txn.
  3. `writeTxn` (pure SQL): insert workflow (dedup by sha) + blob rows; per run:
     `INSERT OR IGNORE` events on `(run_id, seq)`; **derive** `run_state` =
     `foldFacts(genesisToInitialState(parsedEnqueued, ts), facts)` → write
     projection + `next_seq`; insert messages (`INSERT OR IGNORE`, content
     inline). FK closure via `PRAGMA foreign_keys = ON`.
  4. Report (don't gate) the event-contract version.
- **Delete** from import: the carried-`run_state` `insertRunState` /
  `writeRunStateProjection`, the `markRunImported` write, the contract-version
  reject.

**Test:** round-trip — export from store A, `freshStore()` B, import; assert
`getState(B)` deep-equals `getState(A)` modulo local bindings; events/messages/
artifacts counts match; **credential did not travel**. Idempotent re-import →
no-op, counts unchanged. Version gate — hand-craft `bundleVersion`/bad-blob → throws.

## Phase 4 — `fragua show` (new verb)

- New `packages/cli/src/commands/show.ts` — `readTar`, validate (structure +
  blob integrity), replay each run's `events.jsonl` and summarize: status/
  outcome, node count, cost+tokens (`metrics`), duration (last ts − genesis ts),
  `#messages` / `#artifacts` (from `fact.message_appended` / artifact events —
  no body/blob reads). **No store** (no `--db`).
- `bin/fragua.ts` — top-level `show <file.fragua>`, release-gated.

**Test:** `show` on a known bundle → expected summary; on a corrupt/short tar or
bad-hash blob → clean error, non-zero exit.

## Phase 5 — CLI re-wire + delete the tangent surface

- **Promote** `import` + `show` to top-level bundle verbs (`fragua import`,
  `fragua show`); keep `runs export <id>` as the manual single-run counterpart to
  `ci --export`. Wire in `bin/fragua.ts`; release-gate all.
- **Delete:**
  - `packages/workspace/src/run-bundle-git.ts` (`buildRunGitBundle`,
    `rehydrateRunWorktree`, `defaultGitExec` if unused elsewhere) + its export in
    `packages/workspace/src/index.ts`.
  - `runs import --rehydrate` / `--into`, the `rehydrateRun` path in
    `packages/cli/src/commands/run-bundle.ts`.
  - `runs adopt` + `adoptCommand` (`operator.ts`), `adoptRun` / `isRunImported`
    / `setRunCwd` (`store.ts`), `imported_runs` table (`schema.sql`) + the marker
    queries and dispatch/concurrency/sweep gating (`run-state-queries.ts`,
    `sweep.ts`).
  - `packages/daemon/test/snapshot-bundle.test.ts` and the tree-state CLI tests.
- **Grep:** `imported_runs`, `adopt`, `rehydrate`, `gitBundle` across `packages/`
  → zero residue. `VALID_*` action sets / help text updated.

**Test:** full `bun test` + typecheck + lint green; no dead exports.

## Phase 6 — Docs + skill

- `.agents/skills/operate/SKILL.md` — replace the export/import section with the
  `ci --export` / `show` / `import` verbs + the experimental + inspect-only
  (no diff/resume) notes.
- `.github/actions/setup-fragua/README.md`, `.github/workflows/pr-review.yml` —
  reconcile any bundle-artifact references with the new format / gating.
- Confirm `bundles.md` §9 still matches what shipped; flip its `status` toward
  `in-progress` as phases land.

## Sequencing & checkpoints

`0 → 1 → 2 → 3 → 4 → 5 → 6`. Phase 0 is the only live-path change and is
independently valuable. 2 precedes 3 (export gives import fixtures). 5 is pure
subtraction once 2–4 replace the surface. Commit per phase; each ships green
typecheck + lint + the phase's targeted tests.
