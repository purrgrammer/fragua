import type { Database } from "bun:sqlite";

/** Schema version this code emits for new DBs — the DB-migration counter.
 * v2 renames `schedules.input` → `schedules.title` (the run-input cleanup
 * that drops free-form `routing.input`); the walk-forward step lives in
 * `migrations.ts` (SCHEMA_MIGRATIONS). Note: it does NOT gate run resume —
 * runs pin `EVENT_CONTRACT_VERSION` for that (axis split, §3.1).
 * v3 adds the `outputs` index table (structured step outputs, additive).
 * v4 adds `messages.pass` (goal-gate re-entry epoch). The event-payload 4 KiB
 * BYTE cap (I2/I10) is enforced in the store.ts write guard, NOT a SQL CHECK —
 * a byte-exact CHECK can't be applied retroactively over historical rows. */
export const CURRENT_SCHEMA_VERSION = 4;

/** Lowest schema version `migrate()` accepts and walks forward from. A v1
 * store (the 0.1.0 baseline) migrates to current; nothing older exists. */
export const MIN_COMPATIBLE_SCHEMA_VERSION = 1;

/** Event-contract version a run pins at enqueue, and the executor's
 * run-resume gate. DISTINCT from `CURRENT_SCHEMA_VERSION` (the DB-migration
 * counter): it bumps ONLY when `FactEvent`/`IntentEvent` payload shapes or
 * reducer fold-semantics actually change — a rare event — so the resume gate
 * stops tripping on projection-only migrations. See
 * docs/proposals/archive/event-contract-version.md §3.1. The contract-surface hash
 * test (packages/store/test/contract-version.test.ts) forces a conscious
 * bump-or-resnapshot whenever the surface moves.
 * v2 adds the fan-out fold-path facts `fact.fanout_started` /
 * `fact.fanout_joined` (Model A, docs/proposals/fan-out-nodes.md): a v1 daemon
 * would mis-fold a parallel stream. `MIN_COMPATIBLE` stays 1 — v1 runs carry no
 * fan-out facts, so they still resume.
 * v3 adds the folded `partial*` spend fields (+ `nodeId`) on
 * `fact.run_halted`: structural halts (route_not_picked /
 * route_call_not_isolated / edge_no_match) now carry the halted turn's
 * accrued cost so the reducer folds it into run metrics — a v2 daemon
 * would drop that spend from run totals. `MIN_COMPATIBLE` stays 1 — the
 * fields are optional and pre-v3 halts simply carry none.
 * v4 collapses the fact taxonomy (fact-taxonomy.md §3.1–3.2): the three
 * terminal facts (`run_completed` / `run_halted` / `run_cancelled`) become
 * one `fact.run_terminated { status: completed | errored | aborted }`, and
 * the separate `fact.run_paused_human` folds into `fact.run_paused` as
 * `reason: "human"`. The reducer no longer folds the old taxonomy — a clean
 * cut (no back-compat, pre-release), so `MIN_COMPATIBLE` ratchets to 4:
 * a run pinned < 4 carries the dropped fact types and can no longer be
 * folded, so its reducer paths are gone. */
export const EVENT_CONTRACT_VERSION = 4;

/** Lowest contract version the daemon folds. Ratchets ONLY by deliberate act
 * (§3.4): advancing it strands every run pinned below it, so it moves only in
 * a dedicated commit that names the dropped versions and removes their reducer
 * paths. A snapshot test pins this value.
 * Ratcheted 1 → 4 with the v4 fact-taxonomy collapse: v1–v3 runs carry the
 * removed `fact.run_{completed,halted,cancelled,paused_human}` types, whose
 * fold paths the reducer dropped in the same change. */
export const MIN_COMPATIBLE_CONTRACT_VERSION = 4;

/** A `daemon_lock` row whose `heartbeat_at` is older than this is treated as
 * dead — the window the daemon's reaper uses to reclaim a stale lock, and the
 * window `fragua db migrate` uses to decide a harness is live and refuse to
 * race it. One source so the two can't drift. */
export const DAEMON_LOCK_TTL_MS = 30_000;

/**
 * Apply connection-level pragmas. Called on every opened Database.
 *
 * `page_size` is only effective before the database file is populated, so
 * callers must set it via `applyCreationPragmas` on a fresh file.
 */
export function applyPragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA temp_store = MEMORY");
  db.exec("PRAGMA cache_size = -65536");
  db.exec("PRAGMA mmap_size = 268435456");
  db.exec("PRAGMA wal_autocheckpoint = 1000");
}

/**
 * Apply creation-only pragmas. Must run before any CREATE TABLE on a brand-new DB.
 */
export function applyCreationPragmas(db: Database): void {
  db.exec("PRAGMA page_size = 8192");
}
