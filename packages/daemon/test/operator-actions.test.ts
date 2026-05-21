import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FactEvent, IEventStore, RunState, WakeCandidateRow } from "@swarm/store";
import type { IntentType } from "@swarm/types";
import { processOperatorActions } from "../src/operator-actions.ts";

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function gStatus(cwd: string, ...args: string[]): number {
  return spawnSync("git", args, { cwd, encoding: "utf8" }).status ?? 1;
}

interface FakeIntent {
  type: IntentType;
  seq: number;
  payload: unknown;
}

/** Minimal IEventStore exposing only the four methods the sweep calls.
 * Records appended facts so assertions can inspect what the daemon emitted. */
function fakeStore(opts: { runId: string; state: Partial<RunState> & { cwd: string }; intents: FakeIntent[] }): {
  store: IEventStore;
  appended: Array<{ runId: string; fact: FactEvent; advanceAppliedTo: number | undefined }>;
} {
  const appended: Array<{ runId: string; fact: FactEvent; advanceAppliedTo: number | undefined }> = [];
  const candidate: WakeCandidateRow = { runId: opts.runId, version: 1, lastAppliedSeq: 0, status: "completed" };
  const state = {
    runId: opts.runId,
    status: "completed",
    inboxStatus: "pending",
    baseGitRef: "main",
    title: null,
    ...opts.state,
  } as unknown as RunState;

  const store = {
    getInboxActionCandidates: () => [candidate],
    getNextPendingIntent: (_runId: string, type: IntentType, since: number) => {
      const matches = opts.intents.filter((i) => i.type === type && i.seq > since).sort((a, b) => a.seq - b.seq);
      const it = matches[0];
      return it == null ? null : { seq: it.seq, payload: it.payload };
    },
    getState: (runId: string) => (runId === opts.runId ? state : null),
    appendFact: (runId: string, facts: FactEvent[], _v: number, o?: { advanceAppliedTo?: number }) => {
      for (const fact of facts) appended.push({ runId, fact, advanceAppliedTo: o?.advanceAppliedTo });
      return { seqs: facts.map((_, i) => i + 1), version: 2 };
    },
  } as unknown as IEventStore;

  return { store, appended };
}

describe("processOperatorActions", () => {
  let repo: string;
  let base: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "swarm-op-"));
    g(repo, "init", "-q", "-b", "main");
    g(repo, "config", "user.email", "test@swarm.local");
    g(repo, "config", "user.name", "swarm test");
    g(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "a.txt"), "A\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "A");
    base = g(repo, "rev-parse", "HEAD");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("accept: replays the run's commits onto HEAD and emits fact.run_accepted", async () => {
    await writeFile(join(repo, "work.txt"), "work\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "agent work");
    const head = g(repo, "rev-parse", "HEAD");
    g(repo, "reset", "-q", "--hard", base); // main back to base; the run's work survives via the refs
    g(repo, "update-ref", "refs/swarm/heads/run-a", head);
    g(repo, "update-ref", "refs/swarm/snapshots/run-a", head); // snapshot commit; tree == head's tree → no tail

    const { store, appended } = fakeStore({
      runId: "run-a",
      state: { cwd: repo, baseGitSha: base },
      intents: [{ type: "intent.accept_run", seq: 7, payload: {} }],
    });
    const applied = await processOperatorActions(store);

    expect(applied).toEqual(["run-a"]);
    expect(g(repo, "show", "HEAD:work.txt")).toBe("work"); // replayed onto the current branch
    expect(appended).toHaveLength(1);
    const fact = appended[0]?.fact;
    expect(fact?.type).toBe("fact.run_accepted");
    if (fact?.type === "fact.run_accepted") {
      expect(fact.payload.replayed).toBe(1);
      expect(fact.payload.tailStaged).toBe(false);
    }
    expect(appended[0]?.advanceAppliedTo).toBe(7);
  });

  test("discard: deletes both swarm refs and reports them", async () => {
    g(repo, "update-ref", "refs/swarm/snapshots/run-d", base);
    g(repo, "update-ref", "refs/swarm/heads/run-d", base);
    const { store, appended } = fakeStore({
      runId: "run-d",
      state: { cwd: repo },
      intents: [{ type: "intent.discard_run", seq: 7, payload: {} }],
    });
    expect(await processOperatorActions(store)).toEqual(["run-d"]);
    expect(gStatus(repo, "rev-parse", "--verify", "refs/swarm/snapshots/run-d")).not.toBe(0);
    expect(gStatus(repo, "rev-parse", "--verify", "refs/swarm/heads/run-d")).not.toBe(0);
    const fact = appended[0]?.fact;
    if (fact?.type === "fact.run_discarded") {
      expect(fact.payload.refs.sort()).toEqual(["refs/swarm/heads/run-d", "refs/swarm/snapshots/run-d"]);
    }
  });

  test("lowest-seq intent applies first; discarded runs are skipped", async () => {
    g(repo, "update-ref", "refs/swarm/snapshots/run-x", base);
    const discarded = fakeStore({
      runId: "run-x",
      state: { cwd: repo, inboxStatus: "discarded" },
      intents: [{ type: "intent.accept_run", seq: 1, payload: {} }],
    });
    expect(await processOperatorActions(discarded.store)).toEqual([]);
    expect(discarded.appended).toHaveLength(0);
  });

  test("a refused intent does NOT jam later intents (regression: stuck-queue)", async () => {
    // An accept on a run with no snapshot ref is unsatisfiable (no_work).
    // Without the refused-set it would be re-picked every tick and block the
    // discard (seq 2) behind it forever.
    const { store, appended } = fakeStore({
      runId: "run-j",
      state: { cwd: repo, baseGitSha: base },
      intents: [
        { type: "intent.accept_run", seq: 1, payload: {} }, // refused (no snapshot ref → no_work)
        { type: "intent.discard_run", seq: 2, payload: {} },
      ],
    });
    const refused = new Set<string>();

    // Tick 1: the unsatisfiable accept is picked + refused (no fact), recorded.
    expect(await processOperatorActions(store, { refused })).toEqual([]);
    expect(refused.has("run-j:1")).toBe(true);
    // Tick 2: the refused intent is skipped; the discard behind it applies.
    expect(await processOperatorActions(store, { refused })).toEqual(["run-j"]);
    expect(appended.at(-1)?.fact.type).toBe("fact.run_discarded");
  });
});
