// Regression for the HITL tail freeze. A scripted fake store + an injected
// picker drive both gate-resolution paths without an executor or a real TTY.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoredEvent } from "@fragua/store";
import { cliExitCode } from "../src/cli-exit.ts";
import { followRun } from "../src/run-follow.ts";
import type { StoreClient } from "../src/store-client.ts";

const RUN_ID = "r";

function ev(seq: number, type: string, payload: unknown): StoredEvent {
  return { runId: RUN_ID, seq, type, writer: "daemon" as StoredEvent["writer"], payload, ts: seq };
}

/** A store client whose event log is a mutable script and whose `commit`
 * records intents (and can append follow-on facts, mimicking the daemon). */
function fakeClient(events: StoredEvent[]) {
  const commits: unknown[] = [];
  const client = {
    readPlane: {
      eventsSince: (_runId: string, sinceSeq: number, limit?: number) =>
        events.filter((e) => e.seq > sinceSeq).slice(0, limit ?? events.length),
    },
    plane: {
      buildHuman: (body: unknown) => ({ ok: true as const, intent: { type: "intent.human_input", payload: body } }),
      commit: (_runId: string, intent: unknown) => {
        commits.push(intent);
        // Mimic the daemon waking + finishing once the input lands.
        events.push(
          ev(events.length + 1, "fact.run_resumed", {}),
          ev(events.length + 2, "fact.run_terminated", { status: "completed" }),
        );
      },
    },
  };
  return { client: client as unknown as StoreClient, commits };
}

describe("followRun — startCursor", () => {
  test("startCursor skips already-rendered backfill", async () => {
    const events = [
      ev(1, "fact.run_started", {}),
      ev(2, "llm.start", {}),
      ev(3, "llm.done", {}),
      ev(4, "fact.run_terminated", { status: "completed" }),
    ];
    const cursors: number[] = [];
    const client = {
      readPlane: {
        eventsSince: (_runId: string, sinceSeq: number, limit?: number) => {
          cursors.push(sinceSeq);
          return events.filter((e) => e.seq > sinceSeq).slice(0, limit ?? events.length);
        },
      },
    } as unknown as StoreClient;

    const code = await followRun(client, RUN_ID, undefined, 2);

    expect(code).toBe(cliExitCode("completed"));
    expect(cursors[0]).toBe(2); // first poll starts at the given cursor, not 0
  });
});

describe("followRun — idle hint (no daemon)", () => {
  test("emits the daemon hint exactly once on a silent tail, then keeps following", async () => {
    let polls = 0;
    const completed = ev(1, "fact.run_terminated", { status: "completed" });
    const client = {
      readPlane: {
        // Stays silent for several polls (so the idle window elapses), then the
        // run finishes — mimicking a daemon finally coming up.
        eventsSince: (_runId: string, _sinceSeq: number, _limit?: number) => {
          polls += 1;
          return polls >= 6 ? [completed] : [];
        },
      },
    } as unknown as StoreClient;

    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => lines.push(String(msg ?? ""));
    try {
      const code = await followRun(client, RUN_ID, undefined, 0, 1);
      expect(code).toBe(cliExitCode("completed"));
    } finally {
      console.log = orig;
    }

    const hints = lines.filter((l) => l.includes("is a daemon running?"));
    expect(hints).toHaveLength(1);
  }, 5000);
});

describe("followRun — non-human pause", () => {
  test("renders fact.run_paused{budget} and exits non-zero instead of hanging", async () => {
    const { client } = fakeClient([
      ev(1, "fact.run_started", {}),
      ev(2, "fact.run_paused", { reason: "budget", nodeId: "n", scope: "run", metric: "cost", limit: 1, actual: 2 }),
    ]);

    const code = await followRun(client, RUN_ID);

    expect(code).toBe(cliExitCode("paused", { pause: "budget" }));
    expect(code).not.toBe(0);
  }, 3000);

  test("abort_loop pause hint names the looping node and the resume verb", async () => {
    const { client } = fakeClient([
      ev(1, "fact.run_started", {}),
      ev(2, "fact.run_paused", { reason: "abort_loop", nodeId: "reviewer", consecutiveAborts: 3 }),
    ]);

    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => lines.push(String(msg ?? ""));
    let code: number;
    try {
      code = await followRun(client, RUN_ID);
    } finally {
      console.log = orig;
    }

    expect(code).toBe(cliExitCode("paused", { pause: "abort_loop" }));
    const hint = lines.find((l) => l.includes("abort_loop"));
    expect(hint).toContain("reviewer");
    expect(hint).toContain("fragua runs events");
    expect(hint).toContain("fragua runs resume");
  }, 3000);

  test("abort_loop pause hint falls back to a placeholder when nodeId is absent", async () => {
    const { client } = fakeClient([
      ev(1, "fact.run_started", {}),
      ev(2, "fact.run_paused", { reason: "abort_loop", consecutiveAborts: 3 }),
    ]);

    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg?: unknown) => lines.push(String(msg ?? ""));
    let code: number;
    try {
      code = await followRun(client, RUN_ID);
    } finally {
      console.log = orig;
    }

    expect(code).toBe(cliExitCode("paused", { pause: "abort_loop" }));
    const hint = lines.find((l) => l.includes("abort_loop"));
    expect(hint).toContain("the looping node");
    expect(hint).not.toContain("<node>");
  }, 3000);

  test("continues following on an auto-wake pause (timeout_retry) until the run resolves", async () => {
    const { client } = fakeClient([
      ev(1, "fact.run_started", {}),
      ev(2, "fact.run_paused", { reason: "timeout_retry", nodeId: "n", resumeAt: Date.now() + 1000, attempt: 1 }),
      ev(3, "fact.run_resumed", {}),
      ev(4, "fact.run_terminated", { status: "completed" }),
    ]);

    const code = await followRun(client, RUN_ID);

    expect(code).toBe(cliExitCode("completed")); // never exited on the pause
  }, 3000);
});

describe("followRun — HITL gate answered elsewhere (#33)", () => {
  let savedTTY: unknown;
  beforeEach(() => {
    savedTTY = process.stdin.isTTY;
    (process.stdin as { isTTY?: unknown }).isTTY = true;
  });
  afterEach(() => {
    (process.stdin as { isTTY?: unknown }).isTTY = savedTTY;
  });

  test("resolves without freezing when the gate is answered in the web UI", async () => {
    const { client, commits } = fakeClient([
      ev(1, "fact.run_started", {}),
      ev(2, "fact.run_paused", { reason: "human", text: "ok?", routes: ["A"], routeLabels: {} }),
      ev(3, "fact.run_resumed", { fromStatus: "paused_human" }),
      ev(4, "fact.run_terminated", { status: "completed" }),
    ]);
    // The operator never picks in the terminal; the menu only cancels on abort.
    const stuckPicker = (_r: string[], _l: Record<string, string>, _m: string, signal?: AbortSignal) =>
      new Promise<string | undefined>((resolve) => signal?.addEventListener("abort", () => resolve(undefined)));

    const code = await followRun(client, RUN_ID, stuckPicker);

    expect(code).toBe(cliExitCode("completed"));
    expect(commits).toHaveLength(0); // never wrote a second human_input
  });

  test("still commits exactly once when answered inline in the terminal", async () => {
    const { client, commits } = fakeClient([
      ev(1, "fact.run_started", {}),
      ev(2, "fact.run_paused", { reason: "human", text: "ok?", routes: ["A"], routeLabels: {} }),
    ]);
    const inlinePicker = async () => "A";

    const code = await followRun(client, RUN_ID, inlinePicker);

    expect(code).toBe(cliExitCode("completed"));
    expect(commits).toEqual([{ type: "intent.human_input", payload: { route: "A" } }]);
  });
});
