# Run-bundle import — MVP implementation plan

> Implements the **import leg** of [`db-import.md`](db-import.md). The **export leg
> shipped on `main`** (commit `b6040b71`). Build this on branch
> `run-bundle-import` (already cut off `main`, so it has the export).
>
> **Goal: inspect-after-import** (the proposal's floor). A run that executed
> elsewhere (a CI `.fragua` artifact) merges into a local store so
> `fragua runs status|events|messages <run> --db <target>` works.
> **Out of scope:** resume — that needs the git-bundle (tree state), which the
> export does **not** package yet.
>
> Ground rules (CLAUDE.md): branch only, **no `main` pushes**; commit when asked;
> `bun test` + `bun run typecheck` + `bun run lint` green before done; **I1 — no
> `await`/`JSON.stringify`/I/O inside `db.transaction(...)`** (serialize first).

## What already exists on this branch (from the export leg)

`packages/store/src/bundle.ts`:
- `writeTar(entries: readonly TarEntry[]): Uint8Array` — deterministic, manifest-first ustar writer.
- `BUNDLE_VERSION = 1`, `interface TarEntry { name: string; data: Uint8Array }`, and:

```ts
interface BundleManifest {
  bundleVersion: number; fraguaVersion: string; contractVersion: number;
  schemaVersion: number; irVersion: number;
  run: RunState;                                   // full projection (store/types.ts)
  workflow: { sha: string; name: string; source: string; ir: string; irVersion: number };
  events: StoredEvent[];                           // { runId, seq, type, writer, payload, ts }
  messages: Message[];                             // { runId, ordinal, content, nodeId, iteration }
  artifacts: ArtifactListRow[];                    // { nodeId, iteration, key, mime, blobSha, sizeBytes, createdAt }
  blobs: { sha256: string; size: number }[];
}
```

`SqliteStore.exportRunBundle(runId, { fraguaVersion }): Uint8Array` (store.ts) → a `.fragua`:
a tar of `manifest.json` (first entry) then `blobs/<sha256>` for each referenced blob.
CLI: `fragua db export <run> --to <x.fragua>`, `fragua ci --bundle <x.fragua>`.

The store import helpers you'll reuse already live in store.ts's import block:
`insertWorkflowIfAbsent`, `insertBlobIfAbsent`, `insertRunState`,
`writeRunStateProjection`, `insertMessage`, `upsertArtifact`, `sha256Hex`, plus
`MIN_COMPATIBLE_CONTRACT_VERSION`/`EVENT_CONTRACT_VERSION` (add to the pragmas
import if missing).

## Step 1 — `readTar(bytes): TarEntry[]` in `bundle.ts` (inverse of `writeTar`)

```ts
export function readTar(bytes: Uint8Array): TarEntry[] {
  const dec = new TextDecoder();
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= bytes.length) {
    const h = bytes.subarray(off, off + 512);
    if (h[0] === 0) break;                                  // zero block → end
    let n = 0; while (n < 100 && h[n] !== 0) n++;
    const name = dec.decode(h.subarray(0, n));
    const size = parseInt(dec.decode(h.subarray(124, 136)).replace(/[\0 ]/g, ""), 8) || 0;
    off += 512;
    out.push({ name, data: bytes.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;                     // skip padded data
  }
  return out;
}
```
Export it from `packages/store/src/index.ts` (next to `writeTar`).

## Step 2 — `SqliteStore.importRunBundle(bytes): { runId; imported }` in `store.ts`

Place it right after `exportRunBundle`. Structure (mind I1 — serialize + do blob
**file** writes BEFORE the `writeTxn`; only pure SQL inside):

1. `readTar(bytes)` → find `manifest.json` (throw if absent) → `JSON.parse` → `BundleManifest`.
2. **Validate, fail-closed:**
   - `manifest.bundleVersion === BUNDLE_VERSION` else throw.
   - `MIN_COMPATIBLE_CONTRACT_VERSION <= manifest.contractVersion <= EVENT_CONTRACT_VERSION` else throw (the §5 cross-version gate — clear error now; park-on-resume is the daemon's job, not import's).
   - Build `blobBytes = Map<sha, Uint8Array>` from `blobs/<sha>` entries. For every `manifest.blobs[i]`: present in the map AND `sha256Hex(bytes) === sha256` else throw.
3. `const already = this.getState(manifest.run.runId) != null;`
4. **Pre-serialize** (outside the txn): `routingJson = JSON.stringify(run.routing)`, `metricsJson = JSON.stringify(run.metrics)`, `changeStatJson = run.changeStat ? JSON.stringify(run.changeStat) : null`, and each event's `JSON.stringify(ev.payload)` / message's `JSON.stringify(m.content)`.
5. **Write blob files** (fs, OUTSIDE the txn): `for (b of manifest.blobs) this.blobs.put(b.sha256, blobBytes.get(b.sha256)!)`.
6. `this.writeTxn(() => { ... })` — pure SQL only:
   - `insertWorkflowIfAbsent(db, wf.sha, wf.name, wf.source, wf.ir, wf.irVersion, now)` — **confirm arg order/`now` against workflow-queries.ts**.
   - blob rows: `for (b) insertBlobIfAbsent(db, b.sha256, b.size, now)`.
   - if `!already`:
     - `insertRunState(db, { runId, workflowSha, contractVersion, routing: routingJson, metrics: metricsJson, priority, enqueuedAt, readyAt, updatedAt, cwd: null /* rebind */, projectId, projectName, workflowName, workflowScope, workflowPath, scheduleId })`
     - `writeRunStateProjection(db, { runId, version, status, currentNode, routingJson, metricsJson, lastAppliedSeq, priority, readyAt, nodeStartedAt, dispatchStartedAt, updatedAt, baseGitSha, baseGitRef, finalGitSha, finalHeadRef, diffBaseSha, changeStatJson, inboxStatus: "pending" /* reset, §4 */, acceptedSha: null /* reset, §4 */ })`
     - `db.query("UPDATE run_state SET next_seq = ? WHERE run_id = ?").run(run.nextSeq, run.runId)` — projection doesn't carry `next_seq`.
   - events (idempotent): `const ins = db.query("INSERT OR IGNORE INTO events (run_id, seq, type, writer, payload, ts) VALUES (?,?,?,?,?,?)"); for (ev) ins.run(ev.runId, ev.seq, ev.type, ev.writer, payloadJson[i], ev.ts)`.
   - messages: `for (m) insertMessage(db, …)` — **confirm signature** (message-queries.ts:154); content is the pre-serialized JSON.
   - artifacts: `for (a) upsertArtifact(db, …)` — **confirm signature** (artifact-queries.ts:32); FK → blobs (already inserted).
7. `return { runId: manifest.run.runId, imported: !already };`

## Step 3 — CLI: `fragua db import <bundle> [--db <target>]`

`packages/cli/src/commands/db.ts`:
- Add `"import"` to the `action` union; the **bundle path arrives as `opts.run`** (the existing `[run]` positional — reuse it; or read `opts.to` if you prefer `--to`). Pick one and note it in `--help`.
- **The top-level `existsSync(storePath)` guard must NOT apply to `import`** — the target may not exist yet. Special-case: for `import`, `new SqliteStore({ path: storePath })` (default migrate → creates a fresh store at the baseline if absent), `const buf = readFileSync(resolve(cwd, bundlePath)); const { runId, imported } = store.importRunBundle(buf); store.close();` → print `imported run <id>` / `run <id> already present (no-op)`.

`packages/cli/bin/fragua.ts`: add `import` to the `db` valid-action set + the description; the `[run]` positional already exists, so the wiring carries the bundle path through as `run`.

## Step 4 — Test (`packages/store/test/bundle.test.ts`, extend)

`describe("importRunBundle")`:
- **Round-trip:** seed a run + a `provider_credentials` row (helpers `freshStore`/`seedRun`; `store.upsertProviderCredential`), `const bytes = src.exportRunBundle(runId, { fraguaVersion: "x" })`. Open a **fresh** `freshStore()`, `const r = dst.importRunBundle(bytes)`. Assert: `r.runId === runId`, `r.imported === true`, `dst.getState(runId) != null`, `dst.getEvents(runId).length > 0`, and **the credential did not travel** (`dst.getProviderCredential("anthropic") == null`).
- **Idempotent:** `dst.importRunBundle(bytes)` again → `imported === false`, and `dst.getEvents(runId).length` unchanged.
- **Version gate:** hand-craft a tar whose `manifest.contractVersion = 999` (write a manifest with `writeTar`) → `importRunBundle` throws.

## Landmines (these are the bugs to avoid)

- **I1**: `this.blobs.put` is fs I/O and `JSON.stringify` is forbidden inside `writeTxn` — do both **before** the txn.
- **Generated columns**: `run_state.total_cost_usd` / `billed_tokens` are `GENERATED … STORED` — do **not** hand-insert them. `insertRunState` + `writeRunStateProjection` already omit them; that's why you reuse those two rather than a raw 32-column insert.
- **`next_seq`**: `writeRunStateProjection` doesn't set it — patch it from `run.nextSeq` (matters for any future resume).
- **Idempotency**: `INSERT OR IGNORE` for events (PK `(run_id, seq)`); skip the run_state inserts when `already`.
- **Rebind/reset (§4)**: `cwd → null`, `inboxStatus → "pending"`, `acceptedSha → null`.
- **`events.writer`**: it's a free provenance string now (the CHECK was dropped) — insert `ev.writer` verbatim.
- **Import order (FK)**: workflow → blobs → run_state → events/messages/artifacts.

## Verify (done = all green)

```sh
bun run typecheck
bunx biome check --write packages/store/src/bundle.ts packages/store/src/store.ts packages/store/src/index.ts packages/cli/src/commands/db.ts packages/cli/bin/fragua.ts
bun run lint
bun test packages/store/test/bundle.test.ts ./packages/store ./packages/cli
```
Smoke (ephemeral, no global-store touch — seed via a repo-local script like the export smoke):
`fragua db export <run> --db src.db --to r.fragua` → `fragua db import r.fragua --db fresh.db` → `fragua runs status <run> --db fresh.db`.

## Out of scope — follow-ups (do NOT do here)

- **git-bundle / tree state → resume-after-import** (db-import.md §3.1/§3.2): export must `git bundle create refs/fragua/*` into a blob first; import unbundles + recreates refs + rebinds `cwd` to a real worktree.
- message/event **spill blobs** (export currently collects only artifact blobs — see `exportRunBundle`'s note); add full blob enumeration + FK-closure validation.
- run-id **prefix resolution** for `db export`/`db import` ergonomics.
- canonical-JSON (sorted keys) for true re-export determinism (§6).

## Confirmed signatures (don't re-investigate)

```ts
// run-state-queries.ts
insertRunState(db, { runId, workflowSha, contractVersion, routing, metrics, priority,
  enqueuedAt, readyAt, updatedAt, cwd, projectId, projectName, workflowName,
  workflowScope, workflowPath, scheduleId })
writeRunStateProjection(db, { runId, version, status, currentNode, routingJson, metricsJson,
  lastAppliedSeq, priority, readyAt, nodeStartedAt, dispatchStartedAt, updatedAt,
  baseGitSha, baseGitRef, finalGitSha, finalHeadRef, diffBaseSha, changeStatJson,
  inboxStatus, acceptedSha })
// RunState (store/types.ts) carries every field above (camelCase): runId, version,
// status, currentNode, workflowSha, contractVersion, routing, metrics, nextSeq,
// lastAppliedSeq, priority, enqueuedAt, readyAt, nodeStartedAt, dispatchStartedAt,
// updatedAt, title, baseGitSha, baseGitRef, finalGitSha, finalHeadRef, diffBaseSha,
// changeStat, inboxStatus, acceptedSha, cwd, projectId, projectName, workflowName,
// workflowScope, workflowPath, scheduleId
```
(Re-grep `insertWorkflowIfAbsent`, `insertMessage`, `upsertArtifact`, `insertBlobIfAbsent` for exact arg order before calling.)
