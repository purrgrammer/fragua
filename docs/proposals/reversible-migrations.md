---
title: Reversible schema migrations — `{ up, down }` steps + explicit `fragua db migrate --to <version>`
summary: "Give every schema-migration step an optional `down` inverse and add an operator-only `fragua db migrate --to <version>` that walks DOWN as well as up. Today SCHEMA_MIGRATIONS is `Record<targetVersion, up>` and `migrate()` is walk-forward only — a store ahead of the binary is flatly refused, so reversing a bump means hand-rolled sqlite3. The load-bearing constraint: a downgrade is run by the *newer* binary (the only one that knows how to undo its own steps), then you switch back to the older one. Strictly additive to the forward path; downgrade is never automatic, always backed up first, gated on reversibility + daemon-liveness, and orthogonal to the EVENT_CONTRACT_VERSION resume gate."
status: implemented
maturity: shipped
last-reviewed: 2026-05-29
---

# Reversible schema migrations

> **Additive to the forward path; downgrade is explicit and operator-only.**
> Adds a `down` inverse to each `SCHEMA_MIGRATIONS` step and a
> `fragua db migrate --to <version>` that can walk *down*. The automatic
> open/bootstrap path (`migrate()` under the daemon lock, `verifySchema()` for
> store-clients) is **unchanged** — a store newer than the binary still refuses
> to open. Nothing downgrades by surprise.

## 1. Problem

`SCHEMA_MIGRATIONS` is `Record<number, (db) => void>` keyed by the **target**
version, and `migrate()` only ever walks *forward* (`version+1 … CURRENT`).
`checkVersion()` refuses any `version > CURRENT_SCHEMA_VERSION` outright
(`"schema downgrade refused"`). There is no down side and no command to invoke
one.

This surfaced live: an in-progress branch bumped `CURRENT_SCHEMA_VERSION` 2→3
(adding the `outputs` table) and its harness migrated the operator's **live**
`~/.fragua/fragua.db` to v3. Every `main`-built CLI then refused to open the
store. The only recovery was hand-rolled `sqlite3` — `DROP TABLE outputs` +
`UPDATE schema_version SET version = 2`. **That worked only because v3 was
purely additive.** A step that `ALTER`ed or dropped an existing table would
have left no safe manual reversal, and the operator would be stuck choosing
between a stale backup and a corrupted store.

A downgrade should be a first-class, backed-up, reversibility-checked operation
— not an archaeology session in the SQLite shell.

## 2. The load-bearing constraint

**A downgrade is run by the *newer* binary, not the older one.** The v2 binary
cannot reverse v3 — it has no `SCHEMA_MIGRATIONS[3]` entry; it doesn't know v3
*exists*, let alone how to undo it. Only the binary whose
`CURRENT_SCHEMA_VERSION ≥ store.version` carries the `down` steps for every
version in the descending walk.

So the supported flow for the incident is:

```sh
# with the v3 binary (the one that knows step 3):
fragua db migrate --to 2        # runs SCHEMA_MIGRATIONS[3].down, pins 2
# now switch back to the v2 binary — it opens a v2 store cleanly
```

This matches every real migration tool (Rails/Alembic down-migrations are run
by the code that defines them) and it reframes the fix: the right tool was
always "the v3 binary undoing v3," which is exactly the `down` I hand-wrote.
`db migrate --to` formalises it.

## 3. The migration shape — `{ up, down? }`

```ts
interface Migration {
  up: (db: Database) => void;
  down?: (db: Database) => void;   // absent ⇒ irreversible (refuses downgrade past it)
  lossy?: boolean;                 // down restores SHAPE but not DATA — needs --allow-data-loss
}

const SCHEMA_MIGRATIONS: Record<number, Migration> = {
  // v1 → v2: rename. Fully reversible — data preserved both directions.
  2: {
    up:   (db) => db.exec("ALTER TABLE schedules RENAME COLUMN input TO title"),
    down: (db) => db.exec("ALTER TABLE schedules RENAME COLUMN title TO input"),
  },
  // v2 → v3: add a rebuildable projection table. down DROPs it — non-lossy
  // because `outputs` is re-derivable from fact.node_completed.payload.outputs.
  3: {
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS outputs (…) STRICT, WITHOUT ROWID`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_outputs_run ON outputs(run_id, node_id)`);
    },
    down: (db) => {
      db.exec("DROP INDEX IF EXISTS idx_outputs_run");
      db.exec("DROP TABLE IF EXISTS outputs");
    },
  },
};
```

`down[v]` reverses the `up[v]` that *produced* version `v`. The forward walk
calls `step.up`; nothing else about `migrate()` changes.

### Reversibility classification (three cases)

| class | shape | `down` | data | gate |
|---|---|---|---|---|
| **full** | additive (new table/index/column) or rename | present, `lossy` false | round-trips | none |
| **lossy** | drops/narrows a *source-of-truth* column/table | present, `lossy: true` | structure back, values gone | `--allow-data-loss` |
| **irreversible** | one-way (or simply unwritten) | absent | — | refuses downgrade past it |

fragua's event-sourcing earns a useful nuance: dropping a **projection/index**
table (rebuildable from the event log — `outputs`, and most non-`events`
tables) is **full**, not lossy, because the data is re-derivable. Only dropping
the *source of truth* (`events`, `messages`, `blobs` content refs) is genuinely
lossy. The `lossy` flag marks the latter.

## 4. `fragua db migrate --to <version>`

Direction is inferred from the target `N` vs the store's current `C`:

- **`N > C`** (≤ `CURRENT`): forward walk — `up[C+1 … N]`. (`--to` lets you stop
  short of `CURRENT`; omitting `--to` keeps today's behaviour: forward to
  `CURRENT`.)
- **`N === C`**: no-op.
- **`N < C`** (≥ `MIN_COMPATIBLE`): **down walk** — `down[C], down[C-1], …,
  down[N+1]` in descending order, then pin `N`.
- **`N > CURRENT`**: refuse — this binary has no steps past `CURRENT`.
- **`N < MIN_COMPATIBLE`** or **`C > CURRENT`**: refuse (below floor / binary too
  old to know the down steps — §2).

### Down-walk preflight (the gating, before any mutation)

1. **Reversibility scan.** For each `v` in `C … N+1`: require `down` exists. The
   first missing one refuses, naming it: *"cannot downgrade past v{v}: migration
   {v} declares no `down`."* No partial walk runs.
2. **Loss scan.** If any step in range is `lossy`, refuse unless
   `--allow-data-loss`, and print exactly which versions lose what.
3. **Liveness gate.** Refuse if `daemon_lock` shows a live heartbeat — a harness
   is running against this store and would race the auto-migrate. *"stop the
   harness first."* (Reuse the existing heartbeat-staleness constant.)

## 5. Safety rails (baked in from the incident)

- **Auto-backup before mutating — always.** Serialize the store to
  `~/.fragua/backups/pre-migrate-v{C}-to-v{N}-<ts>.db` via the **same
  `serialize()` path `db backup` already uses** (NOT `VACUUM INTO` — STORED
  generated columns trip a column-count mismatch on replay). Print the path.
  `--no-backup` opts out for ephemeral/CI stores. This is precisely what made
  the manual restore safe; make it non-optional by default.
- **One transaction.** The whole down-walk + version pin run inside a single
  `db.transaction()`, mirroring `migrate()` — a failing `down` rolls the entire
  walk back.
- **No `schema.sql` re-run on the down path.** The forward walk re-runs
  `schema.sql` first (idempotent `CREATE … IF NOT EXISTS`); the down walk must
  **not** — re-running it would recreate the very objects a `down` just dropped.
  Down is pure step-deltas + pin.
- **WAL checkpoint (TRUNCATE)** before the backup and after the walk so the
  on-disk file the backup captures (and the store the older binary reopens) is
  consistent.
- **`--dry-run`** prints the descending plan with each step's reversibility
  class and whether a backup will be taken — applies nothing. (Extends the
  existing `db migrate --dry-run`.)

### Where the code lives

A new `migrateTo(db, target, { allowDataLoss })` in `migrations.ts` (the
engine) holds the down-walk; `fragua db migrate --to` is its only caller.
`migrate()` (auto-run under the daemon lock) and `verifySchema()` (store-client
open) are **untouched** — a store ahead of the binary still refuses to open, so
nobody silently downgrades a teammate's store by running an old binary. Explicit
intent, newer binary, backup first.

## 6. Orthogonal to `EVENT_CONTRACT_VERSION`

Schema downgrade moves the **DB-structure** counter only. It does **not** touch
per-run `contract_version` pins, and it is **not** a way to make newer-contract
runs resumable on an older daemon — a run pinned above the daemon's supported
contract band still pauses `engine_incompatible` (the existing recoverable
mechanism, SPEC §5 / ARCH §1.11). Two axes, two mechanisms; `db migrate --to`
owns only the schema axis. (Down-migrating *event-contract* folds is a much
harder, separate question and stays out of scope.)

## 7. Doc + test deltas this entails

- **`migrations.ts`** — shape change `(db)=>void` → `Migration`; `migrate()`
  calls `step.up`; add `migrateTo()`. Both v2 and v3 (when it lands) gain a
  `down`.
- **`packages/cli/src/commands/db.ts`** — `--to <n>` / `--allow-data-loss` /
  `--no-backup` on `migrate`; direction inference + preflight; reuse the
  `backup` serialize path; exit-code mapping for each refusal.
- **`docs/cli.md`** — document `db migrate --to`, the flags, and the
  "run with the newer binary" note.
- **`docs/ARCHITECTURE.md` §1.11** (the migration paragraph) and **`docs/SPEC.md`
  §5** — record that schema downgrade is a supported explicit operator action,
  distinct from the contract auto-migration that stays out of scope.
- **Tests:**
  1. **Round-trip property test** — for every step with a non-`lossy` `down`,
     `up∘down` on a v(v-1) store and `down∘up` on a v(v) store each return the
     canonical `sqlite_master` shape (normalised) to the original. fast-check
     over a seeded store.
  2. **Coverage discipline test** — every `SCHEMA_MIGRATIONS[v]` must declare a
     `down` *or* appear in an explicit `IRREVERSIBLE` set with a reason, so
     "forgot the down" can't slip through (mirrors the contract-surface-hash
     discipline).
  3. Existing forward-migrate tests stay green (shape change is mechanical).

## 8. Open questions — resolved at implementation

- **Forward partial `--to`** — **kept.** `--to` infers direction from target vs
  current; a forward target below CURRENT is allowed. One caveat surfaced in the
  code: `schema.sql` only ever encodes the CURRENT shape, so the full forward
  walk re-runs it but a *partial* forward (`target < CURRENT`) does **not** —
  it relies on the `up`-step deltas alone, which therefore must be
  self-contained (create their own additive objects, not lean on `schema.sql`).
  Moot on `main` (CURRENT=2, no intermediate target exists) but load-bearing
  once v3+ lands.
- **Backup scope** — **all operator-invoked migrates** back up first (forward
  and down), `--no-backup` to opt out. The backup lands beside the store
  (`<store dir>/backups/`), not a central `~/.fragua/backups/`, so a `--db`
  project store backs up next to itself. Retention/pruning still out of scope.
- **`v2`'s `down` correctness.** The rename inverse is trivial; re-check the
  ordering assumption when a v4 lands.

The v3 `outputs`-table step (and its `down`) lands with the structured-outputs
branch; the engine here ships independently on `main`.

## Related

- `packages/store/src/migrations.ts` — `SCHEMA_MIGRATIONS`, `migrate()`,
  `verifySchema()`, `checkVersion()` (the forward-only system this extends).
- `packages/cli/src/commands/db.ts` — `fragua db migrate` (forward, consent-driven)
  and `db backup` (the `serialize()` path the auto-backup reuses).
- `docs/proposals/archive/event-contract-version.md` — the *other* version axis
  (`EVENT_CONTRACT_VERSION`), deliberately untouched here (§6).
