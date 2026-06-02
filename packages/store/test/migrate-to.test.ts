// Reversible migrations — `migrateTo` walks UP or DOWN to an explicit target,
// `planMigration` is the pure plan behind it, and every registered step is
// reversible XOR explicitly irreversible. See migrations.ts.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { migrate, migrateTo, migrationRegistry, planMigration } from "../src/migrations.ts";
import {
  applyCreationPragmas,
  applyPragmas,
  CURRENT_SCHEMA_VERSION,
  MIN_COMPATIBLE_SCHEMA_VERSION,
} from "../src/pragmas.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  applyCreationPragmas(db);
  applyPragmas(db);
  return db;
}

function version(db: Database): number {
  return db.query<{ version: number }, []>("SELECT version FROM schema_version WHERE id = 1").get()!.version;
}

function scheduleCols(db: Database): string[] {
  return db
    .query<{ name: string }, []>("PRAGMA table_info(schedules)")
    .all()
    .map((c) => c.name)
    .sort();
}

/** Drop a current-shape store back to a simulated v1 (pre-rename) store. */
function toV1(db: Database): void {
  db.query("ALTER TABLE schedules RENAME COLUMN title TO input").run();
  db.query("UPDATE schema_version SET version = 1").run();
}

describe("migration coverage discipline", () => {
  test("every registered step is reversible XOR explicitly irreversible", () => {
    const { versions, reversible, irreversible } = migrationRegistry();
    for (const v of versions) {
      const hasDown = reversible.includes(v);
      const declaredIrreversible = irreversible.includes(v);
      expect(hasDown !== declaredIrreversible).toBe(true); // XOR — not both, not neither
    }
  });
});

describe("planMigration — pure, side-effect-free direction inference", () => {
  test("equal target is a no-op", () => {
    expect(planMigration(2, 2)).toEqual({ from: 2, to: 2, direction: "none", steps: [] });
  });

  test("forward lists ascending up-step versions", () => {
    const plan = planMigration(1, 2);
    expect(plan.direction).toBe("up");
    expect(plan.steps.map((s) => s.version)).toEqual([2]);
  });

  test("down lists descending versions to undo", () => {
    const plan = planMigration(2, 1);
    expect(plan.direction).toBe("down");
    expect(plan.steps.map((s) => s.version)).toEqual([2]);
    expect(plan.steps[0]?.class).toBe("full"); // step 2's down round-trips
  });

  test("step.version is direction-relative: forward up(2) vs down(2) both read v2", () => {
    // The asymmetry is intentional and a one-off-by-one trap for a future
    // step author: forward steps[].version is the version the `up` PRODUCES;
    // down steps[].version is the version whose `down` runs (landing on
    // version-1). For the 1↔2 hop both directions surface v2 — but the
    // forward runs `up[2]` and the down runs `down[2]`.
    expect(planMigration(1, 2).steps[0]?.version).toBe(2);
    expect(planMigration(2, 1).steps[0]?.version).toBe(2);
  });

  test("a non-integer target is refused (the invariant lives in planMigration)", () => {
    expect(() => planMigration(2, 2.5)).toThrow(/integer/i);
  });

  test("target past CURRENT is refused", () => {
    expect(() => planMigration(CURRENT_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION + 1)).toThrow(/only knows up to/i);
  });

  test("target below the floor is refused", () => {
    expect(() => planMigration(CURRENT_SCHEMA_VERSION, MIN_COMPATIBLE_SCHEMA_VERSION - 1)).toThrow(
      /below the supported floor/i,
    );
  });

  test("store newer than this binary is refused (run the newer binary)", () => {
    expect(() => planMigration(CURRENT_SCHEMA_VERSION + 1, CURRENT_SCHEMA_VERSION)).toThrow(/newer than this binary/i);
  });
});

describe("migrateTo — applies the walk and pins the target", () => {
  test("down: v2 → v1 reverses the rename and pins 1", () => {
    const db = freshDb();
    migrate(db); // current shape: schedules.title
    expect(scheduleCols(db)).toContain("title");

    migrateTo(db, 1);
    expect(version(db)).toBe(1);
    expect(scheduleCols(db)).toContain("input");
    expect(scheduleCols(db)).not.toContain("title");
    db.close();
  });

  test("forward: v1 → CURRENT applies up steps and pins CURRENT", () => {
    const db = freshDb();
    migrate(db);
    toV1(db);

    migrateTo(db, CURRENT_SCHEMA_VERSION);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(scheduleCols(db)).toContain("title");
    db.close();
  });

  test("no-op when already at target", () => {
    const db = freshDb();
    migrate(db);
    const before = scheduleCols(db);
    migrateTo(db, CURRENT_SCHEMA_VERSION);
    expect(version(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(scheduleCols(db)).toEqual(before);
    db.close();
  });

  test("refuses a target past CURRENT", () => {
    const db = freshDb();
    migrate(db);
    expect(() => migrateTo(db, CURRENT_SCHEMA_VERSION + 1)).toThrow(/only knows up to/i);
    db.close();
  });

  test("non-assumeLocked sets a defensive busy_timeout on a bare connection", () => {
    // A caller that skipped applyPragmas (default busy_timeout=0) must still get
    // a sane timeout so the walk's BEGIN IMMEDIATE waits rather than instant-BUSY.
    const db = new Database(":memory:");
    applyCreationPragmas(db);
    migrate(db); // bootstrap to CURRENT without applyPragmas
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(0);
    toV1(db);
    migrateTo(db, CURRENT_SCHEMA_VERSION); // non-assumeLocked walk
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    db.close();
  });

  test("assumeLocked runs the walk inside the caller's transaction", () => {
    const db = freshDb();
    migrate(db); // v2: schedules.title
    // Caller owns the transaction; migrateTo must NOT open its own (a second
    // BEGIN would throw) and must NOT commit (the COMMIT below would then fail).
    db.exec("BEGIN IMMEDIATE");
    const plan = migrateTo(db, 1, { assumeLocked: true });
    db.exec("COMMIT");
    expect(plan.direction).toBe("down");
    expect(version(db)).toBe(1);
    expect(scheduleCols(db)).toContain("input");
    db.close();
  });
});

describe("up ∘ down round-trips schema shape and data (non-lossy steps)", () => {
  test("a seeded v1 store survives up→down identical", () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1, maxLength: 40 }), { minLength: 0, maxLength: 8 }), (titles) => {
        const db = freshDb();
        migrate(db);
        toV1(db); // schedules.input, version 1

        // Seed rows under the v1 column name.
        titles.forEach((t, i) => {
          db.query(
            "INSERT INTO schedules (id, workflow_ref, cwd, project_id, interval_ms, interval_text, input, next_fire_at, created_at) " +
              "VALUES (?, 'wf', '/p', 'p', 3600000, '1h', ?, 0, 0)",
          ).run(`s${i}`, t);
        });
        const colsV1 = scheduleCols(db);

        migrateTo(db, CURRENT_SCHEMA_VERSION); // up
        migrateTo(db, 1); // down

        expect(version(db)).toBe(1);
        expect(scheduleCols(db)).toEqual(colsV1); // shape round-trips
        const values = db
          .query<{ input: string }, []>("SELECT input FROM schedules ORDER BY id")
          .all()
          .map((r) => r.input)
          .sort();
        expect(values).toEqual([...titles].sort()); // data round-trips
        db.close();
      }),
      { numRuns: 25 },
    );
  });
});
