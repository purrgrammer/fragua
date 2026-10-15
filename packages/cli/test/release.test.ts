import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_IR_VERSION, parseWorkflow, serializeGraph } from "@fragua/core";
import { type FactEvent, SqliteStore } from "@fragua/store";
import { releaseCommand } from "../src/commands/release.ts";

const BASE = "a".repeat(40);
const WF = "name: t\nsteps:\n  n1: {type: llm, prompt: x}\n";

describe("fragua runs release", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteStore;
  let out: string[];
  let err: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fragua-release-"));
    dbPath = join(dir, "t.db");
    store = new SqliteStore({ path: dbPath });
    store.saveWorkflow("wf", "noop", WF, serializeGraph(parseWorkflow(WF)), CURRENT_IR_VERSION);
    out = [];
    err = [];
    spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
    spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      err.push(a.join(" "));
    });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const append = (runId: string, f: FactEvent) => store.appendFact(runId, [f], store.getState(runId)!.version);
  const started = (runId: string) =>
    append(runId, {
      type: "fact.run_started",
      payload: { workflowSha: "wf", contractVersion: 7, startNode: "n1", baseGitSha: BASE },
    });

  test("refuses not_checkout_run / not_terminal / already_released with non-zero exit", async () => {
    store.enqueueRun({ runId: "plain", workflowSha: "wf", cwd: "/tmp/repo" });
    expect(await releaseCommand({ runId: "plain", dbPath })).toBe(1);

    store.enqueueRun({ runId: "live", workflowSha: "wf", cwd: "/tmp/repo", inCheckout: true, checkoutPath: "/co1" });
    expect(await releaseCommand({ runId: "live", dbPath })).toBe(1);

    store.enqueueRun({ runId: "gone", workflowSha: "wf", cwd: "/tmp/repo", inCheckout: true, checkoutPath: "/co2" });
    append("gone", { type: "fact.run_terminated", payload: { status: "aborted", intentSeq: 0 } }); // never started
    expect(await releaseCommand({ runId: "gone", dbPath })).toBe(1);

    expect(await releaseCommand({ runId: "nope", dbPath })).toBe(1);
    const e = err.join("\n");
    expect(e).toContain("[not_checkout_run]");
    expect(e).toContain("[not_terminal]");
    expect(e).toContain("[already_released]");
    expect(e).toContain("run not found");
  });

  test("releases a halted holder: fact.checkout_released folded, checkoutReleased true", async () => {
    store.enqueueRun({ runId: "h", workflowSha: "wf", cwd: "/tmp/repo", inCheckout: true, checkoutPath: "/co" });
    started("h");
    append("h", { type: "fact.run_terminated", payload: { status: "errored", reason: "error" } });
    expect(store.getCheckoutHolder("/co")?.runId).toBe("h");
    expect(await releaseCommand({ runId: "h", dbPath })).toBe(0);
    store.close();
    store = new SqliteStore({ path: dbPath });
    const state = store.getState("h")!;
    expect(state.checkoutReleased).toBe(true);
    const types = store.getEvents("h").map((e) => e.type);
    expect(types.slice(-2)).toEqual(["intent.checkout_release", "fact.checkout_released"]);
    expect(store.getCheckoutHolder("/co")).toBeNull();
    expect(out.join("\n")).toContain("released checkout /co");
  });

  test("release on an imported run exits 1 with an imported-run message", async () => {
    store.enqueueRun({ runId: "imp", workflowSha: "wf", cwd: "/tmp/repo", inCheckout: true, checkoutPath: "/co4" });
    started("imp");
    append("imp", { type: "fact.run_terminated", payload: { status: "errored", reason: "error" } });
    const db = (store as unknown as { db: Database }).db;
    db.query("INSERT INTO imported_runs (run_id, imported_at) VALUES (?, ?)").run("imp", 0);
    const seqBefore = store.getState("imp")!.nextSeq;

    expect(await releaseCommand({ runId: "imp", dbPath })).toBe(1);
    expect(err.join("\n")).toContain("imported run");
    expect(store.getState("imp")!.nextSeq).toBe(seqBefore);
  });

  test("a completed run without a recorded snapshot: the message names the snapshot caveat", async () => {
    store.enqueueRun({ runId: "c", workflowSha: "wf", cwd: "/tmp/repo", inCheckout: true, checkoutPath: "/co3" });
    started("c");
    append("c", { type: "fact.run_terminated", payload: { status: "completed", finalNode: "n1" } });
    expect(await releaseCommand({ runId: "c", dbPath })).toBe(0);
    expect(out.join("\n")).toContain("its terminal snapshot may still be recording");
  });
});
