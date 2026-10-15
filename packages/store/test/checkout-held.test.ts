import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CheckoutBusyError, ConcurrencyError, type FactEvent, ImportedRunError } from "../src/index.ts";
import { freshStore, nextId, seedWorkflow } from "./helpers.ts";

const KEY = "/home/dev/feature-wt";

type Store = ReturnType<typeof freshStore>;

async function terminalCheckoutRun(store: Store): Promise<string> {
  const sha = await seedWorkflow(store);
  const runId = nextId();
  store.enqueueRun({ runId, workflowSha: sha, inCheckout: true, checkoutPath: KEY });
  const append = (f: FactEvent) => store.appendFact(runId, [f], store.getState(runId)!.version);
  append({
    type: "fact.run_started",
    payload: { workflowSha: sha, contractVersion: 7, startNode: "a", baseGitSha: "5".repeat(40) },
  });
  append({ type: "fact.run_terminated", payload: { status: "errored", reason: "error" } });
  return runId;
}

function release(store: Store, runId: string): { intentSeq: number } {
  return store.appendIntentWithFact(
    runId,
    { type: "intent.checkout_release", payload: {} },
    [{ type: "fact.checkout_released", payload: {} }],
    store.getState(runId)!.version,
  );
}

describe("CHECKOUT_HELD_SQL", () => {
  test("a queued checkout run holds its key", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const runId = nextId();
    store.enqueueRun({ runId, workflowSha: sha, inCheckout: true, checkoutPath: KEY });
    expect(store.getCheckoutHolder(KEY)).toEqual({ runId, status: "queued" });
    expect(store.getCheckoutHolder("/elsewhere")).toBeNull();
    store.close();
  });

  test("enqueueRun on a held key throws CheckoutBusyError naming the holder and writes no row", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const holder = nextId();
    store.enqueueRun({ runId: holder, workflowSha: sha, inCheckout: true, checkoutPath: KEY });
    const second = nextId();
    let caught: unknown;
    try {
      store.enqueueRun({ runId: second, workflowSha: sha, inCheckout: true, checkoutPath: KEY });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CheckoutBusyError);
    expect((caught as CheckoutBusyError).holder.runId).toBe(holder);
    expect(store.getState(second)).toBeNull();
    store.close();
  });

  test("a released holder no longer holds", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const runId = nextId();
    store.enqueueRun({ runId, workflowSha: sha, inCheckout: true, checkoutPath: KEY });
    // cancelled while queued: never started → auto-released
    store.appendFact(
      runId,
      [{ type: "fact.run_terminated", payload: { status: "aborted", intentSeq: 0 } }],
      store.getState(runId)!.version,
    );
    expect(store.getState(runId)!.checkoutReleased).toBe(true);
    expect(store.getCheckoutHolder(KEY)).toBeNull();
    store.enqueueRun({ runId: nextId(), workflowSha: sha, inCheckout: true, checkoutPath: KEY });
    store.close();
  });

  test("an imported run never holds", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const runId = nextId();
    store.enqueueRun({ runId, workflowSha: sha, inCheckout: true, checkoutPath: KEY });
    const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
    db.query("INSERT INTO imported_runs (run_id, imported_at) VALUES (?, 0)").run(runId);
    expect(store.getCheckoutHolder(KEY)).toBeNull();
    store.close();
  });
});

describe("appendIntentWithFact", () => {
  test("writes intent and fact in one txn and advances last_applied_seq to the intent seq", async () => {
    const store = freshStore();
    const sha = await seedWorkflow(store);
    const runId = nextId();
    store.enqueueRun({ runId, workflowSha: sha, inCheckout: true, checkoutPath: KEY });
    const append = (f: FactEvent) => store.appendFact(runId, [f], store.getState(runId)!.version);
    append({
      type: "fact.run_started",
      payload: { workflowSha: sha, contractVersion: 7, startNode: "a", baseGitSha: "5".repeat(40) },
    });
    append({ type: "fact.run_terminated", payload: { status: "errored", reason: "error" } });
    const before = store.getState(runId)!;
    expect(before.checkoutReleased).toBe(false);
    const r = store.appendIntentWithFact(
      runId,
      { type: "intent.checkout_release", payload: {} },
      [{ type: "fact.checkout_released", payload: {} }],
      before.version,
    );
    const after = store.getState(runId)!;
    expect(after.checkoutReleased).toBe(true);
    expect(after.version).toBe(before.version + 1);
    expect(after.lastAppliedSeq).toBe(r.intentSeq);
    const tail = store.getEvents(runId).slice(-2);
    expect(tail.map((e) => [e.type, e.seq])).toEqual([
      ["intent.checkout_release", r.intentSeq],
      ["fact.checkout_released", r.factSeqs[0]!],
    ]);
    expect(store.getUnappliedIntents(runId)).toEqual([]);
    expect(() =>
      store.appendIntentWithFact(
        runId,
        { type: "intent.checkout_release", payload: {} },
        [{ type: "fact.checkout_released", payload: {} }],
        before.version,
      ),
    ).toThrow(ConcurrencyError);
    store.close();
  });

  test("a pending cancel survives appendIntentWithFact and stays unapplied", async () => {
    const store = freshStore();
    const runId = await terminalCheckoutRun(store);
    const cancel = store.appendIntent(runId, { type: "intent.cancel_requested", payload: {} });

    const r = release(store, runId);

    const after = store.getState(runId)!;
    expect(after.checkoutReleased).toBe(true);
    expect(after.lastAppliedSeq).toBeLessThan(cancel.seq);
    const unapplied = store.getUnappliedIntents(runId).map((e) => e.seq);
    expect(unapplied).toContain(cancel.seq);
    expect(unapplied).toContain(r.intentSeq);
    store.close();
  });

  test("a pending accept_run is not skipped by appendIntentWithFact", async () => {
    const store = freshStore();
    const runId = await terminalCheckoutRun(store);
    const accept = store.appendIntent(runId, {
      type: "intent.accept_run",
      payload: { sha: "a".repeat(40), replayed: 1, tailStaged: false },
    });

    release(store, runId);

    const after = store.getState(runId)!;
    expect(store.getNextPendingIntent(runId, "intent.accept_run", after.lastAppliedSeq)?.seq).toBe(accept.seq);
    store.close();
  });

  test("appendIntentWithFact on an imported run throws ImportedRunError and writes nothing", async () => {
    const store = freshStore();
    const runId = await terminalCheckoutRun(store);
    const db = (store as unknown as { db: Database }).db;
    db.query("INSERT INTO imported_runs (run_id, imported_at) VALUES (?, ?)").run(runId, 0);
    const before = store.getState(runId)!;

    expect(() => release(store, runId)).toThrow(ImportedRunError);
    const after = store.getState(runId)!;
    expect(after.nextSeq).toBe(before.nextSeq);
    expect(after.version).toBe(before.version);
    expect(after.checkoutReleased).toBe(false);
    store.close();
  });
});
