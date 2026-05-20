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

  test("branch: promotes the heads ref to refs/heads/<branch>", async () => {
    // Build a commit C on top of base and pin it as the run's heads ref.
    await writeFile(join(repo, "work.txt"), "work\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "agent work");
    const head = g(repo, "rev-parse", "HEAD");
    g(repo, "reset", "-q", "--hard", base); // main back to base; C survives via the ref
    g(repo, "update-ref", "refs/swarm/heads/run-b", head);
    g(repo, "update-ref", "refs/swarm/snapshots/run-b", head);

    const { store, appended } = fakeStore({
      runId: "run-b",
      state: { cwd: repo },
      intents: [{ type: "intent.branch_run", seq: 5, payload: { branch: "promoted" } }],
    });
    const applied = await processOperatorActions(store);

    expect(applied).toEqual(["run-b"]);
    expect(g(repo, "rev-parse", "refs/heads/promoted")).toBe(head);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.fact).toEqual({ type: "fact.run_branched", payload: { branch: "promoted", sha: head } });
    expect(appended[0]?.advanceAppliedTo).toBe(5);
  });

  test("branch: refuses (no fact) when no heads ref exists", async () => {
    g(repo, "update-ref", "refs/swarm/snapshots/run-nh", base); // snapshot only, no heads
    const { store, appended } = fakeStore({
      runId: "run-nh",
      state: { cwd: repo },
      intents: [{ type: "intent.branch_run", seq: 1, payload: { branch: "x" } }],
    });
    const applied = await processOperatorActions(store);
    expect(applied).toEqual([]);
    expect(appended).toHaveLength(0);
    expect(gStatus(repo, "rev-parse", "--verify", "refs/heads/x")).not.toBe(0);
  });

  test("branch: refuses an existing branch without force, overwrites with force", async () => {
    await writeFile(join(repo, "w.txt"), "w\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "w");
    const head = g(repo, "rev-parse", "HEAD");
    g(repo, "reset", "-q", "--hard", base);
    g(repo, "update-ref", "refs/swarm/heads/run-f", head);
    g(repo, "branch", "taken", base); // pre-existing branch at base

    const noForce = fakeStore({
      runId: "run-f",
      state: { cwd: repo },
      intents: [{ type: "intent.branch_run", seq: 1, payload: { branch: "taken" } }],
    });
    expect(await processOperatorActions(noForce.store)).toEqual([]);
    expect(g(repo, "rev-parse", "refs/heads/taken")).toBe(base); // untouched

    const forced = fakeStore({
      runId: "run-f",
      state: { cwd: repo },
      intents: [{ type: "intent.branch_run", seq: 2, payload: { branch: "taken", force: true } }],
    });
    expect(await processOperatorActions(forced.store)).toEqual(["run-f"]);
    expect(g(repo, "rev-parse", "refs/heads/taken")).toBe(head);
  });

  test("commit: commit-trees the snapshot tree onto base_git_ref and advances it", async () => {
    // snapshot commit carries a dirt file on top of base's tree
    await writeFile(join(repo, "dirt.txt"), "dirt\n");
    g(repo, "add", "-A");
    const tree = g(repo, "write-tree");
    g(repo, "reset", "-q", "--hard", base);
    const snap = g(repo, "commit-tree", tree, "-p", base, "-m", "snap");
    g(repo, "update-ref", "refs/swarm/snapshots/run-c", snap);

    const { store, appended } = fakeStore({
      runId: "run-c",
      state: { cwd: repo },
      intents: [{ type: "intent.commit_run", seq: 9, payload: { message: "promote dirt" } }],
    });
    const applied = await processOperatorActions(store);

    expect(applied).toEqual(["run-c"]);
    const newTip = g(repo, "rev-parse", "refs/heads/main");
    expect(g(repo, "rev-parse", `${newTip}^`)).toBe(base); // parent is old main tip
    expect(g(repo, "rev-parse", `${newTip}^{tree}`)).toBe(tree); // full snapshot tree
    const fact = appended[0]?.fact;
    expect(fact?.type).toBe("fact.run_committed");
    if (fact?.type === "fact.run_committed") {
      expect(fact.payload.targetBranch).toBe("main");
      expect(fact.payload.parentSha).toBe(base);
      expect(fact.payload.message).toBe("promote dirt");
      expect(fact.payload.sha).toBe(newTip);
    }
  });

  test("merge ff: fast-forwards the target to the heads ref", async () => {
    await writeFile(join(repo, "ff.txt"), "ff\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "ff work");
    const head = g(repo, "rev-parse", "HEAD");
    g(repo, "reset", "-q", "--hard", base); // main at base; head descends from base
    g(repo, "update-ref", "refs/swarm/heads/run-ff", head);

    const { store, appended } = fakeStore({
      runId: "run-ff",
      state: { cwd: repo },
      intents: [{ type: "intent.merge_run", seq: 3, payload: {} }],
    });
    expect(await processOperatorActions(store)).toEqual(["run-ff"]);
    expect(g(repo, "rev-parse", "refs/heads/main")).toBe(head);
    const fact = appended[0]?.fact;
    expect(fact?.type).toBe("fact.run_merged");
    if (fact?.type === "fact.run_merged") {
      expect(fact.payload.mode).toBe("ff");
      expect(fact.payload.sha).toBe(head);
    }
  });

  test("merge ff: refuses when the target has diverged", async () => {
    // heads on a feature line, main advanced divergently
    await writeFile(join(repo, "feat.txt"), "feat\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "feat");
    const head = g(repo, "rev-parse", "HEAD");
    g(repo, "reset", "-q", "--hard", base);
    await writeFile(join(repo, "main2.txt"), "main2\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "main moves");
    g(repo, "update-ref", "refs/swarm/heads/run-nd", head);
    const mainTip = g(repo, "rev-parse", "refs/heads/main");

    const { store, appended } = fakeStore({
      runId: "run-nd",
      state: { cwd: repo },
      intents: [{ type: "intent.merge_run", seq: 1, payload: { mode: "ff" } }],
    });
    expect(await processOperatorActions(store)).toEqual([]);
    expect(appended).toHaveLength(0);
    expect(g(repo, "rev-parse", "refs/heads/main")).toBe(mainTip); // unchanged
  });

  test("merge no-ff: writes a two-parent merge commit", async () => {
    await writeFile(join(repo, "feat.txt"), "feat\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "feat");
    const head = g(repo, "rev-parse", "HEAD");
    g(repo, "reset", "-q", "--hard", base);
    await writeFile(join(repo, "main2.txt"), "main2\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "main moves");
    const mainTip = g(repo, "rev-parse", "refs/heads/main");
    g(repo, "update-ref", "refs/swarm/heads/run-nf", head);

    const { store, appended } = fakeStore({
      runId: "run-nf",
      state: { cwd: repo },
      intents: [{ type: "intent.merge_run", seq: 1, payload: { mode: "no-ff" } }],
    });
    expect(await processOperatorActions(store)).toEqual(["run-nf"]);
    const merge = g(repo, "rev-parse", "refs/heads/main");
    expect(g(repo, "rev-list", "--parents", "-n", "1", merge).split(" ").slice(1).sort()).toEqual(
      [mainTip, head].sort(),
    );
    const fact = appended[0]?.fact;
    if (fact?.type === "fact.run_merged") {
      expect(fact.payload.mode).toBe("merge");
      expect(fact.payload.parentShas.sort()).toEqual([mainTip, head].sort());
    }
  });

  test("merge squash: writes a single-parent commit on the target", async () => {
    await writeFile(join(repo, "feat.txt"), "feat\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "feat");
    const head = g(repo, "rev-parse", "HEAD");
    g(repo, "reset", "-q", "--hard", base);
    await writeFile(join(repo, "main2.txt"), "main2\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "-m", "main moves");
    const mainTip = g(repo, "rev-parse", "refs/heads/main");
    g(repo, "update-ref", "refs/swarm/heads/run-sq", head);

    const { store, appended } = fakeStore({
      runId: "run-sq",
      state: { cwd: repo },
      intents: [{ type: "intent.merge_run", seq: 1, payload: { mode: "squash" } }],
    });
    expect(await processOperatorActions(store)).toEqual(["run-sq"]);
    const sq = g(repo, "rev-parse", "refs/heads/main");
    expect(g(repo, "rev-parse", `${sq}^`)).toBe(mainTip);
    expect(gStatus(repo, "rev-parse", `${sq}^2`)).not.toBe(0); // single parent
    const fact = appended[0]?.fact;
    if (fact?.type === "fact.run_merged") {
      expect(fact.payload.mode).toBe("squash");
      expect(fact.payload.parentShas).toEqual([mainTip]);
    }
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
      intents: [{ type: "intent.commit_run", seq: 1, payload: { message: "m" } }],
    });
    expect(await processOperatorActions(discarded.store)).toEqual([]);
    expect(discarded.appended).toHaveLength(0);
  });
});
