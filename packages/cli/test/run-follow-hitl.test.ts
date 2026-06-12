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
        events.push(ev(events.length + 1, "fact.run_resumed", {}), ev(events.length + 2, "fact.run_completed", {}));
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
      ev(4, "fact.run_completed", {}),
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
      ev(2, "fact.run_paused_human", { text: "ok?", routes: ["A"], routeLabels: {} }),
      ev(3, "fact.run_resumed", { fromStatus: "paused_human" }),
      ev(4, "fact.run_completed", {}),
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
      ev(2, "fact.run_paused_human", { text: "ok?", routes: ["A"], routeLabels: {} }),
    ]);
    const inlinePicker = async () => "A";

    const code = await followRun(client, RUN_ID, inlinePicker);

    expect(code).toBe(cliExitCode("completed"));
    expect(commits).toEqual([{ type: "intent.human_input", payload: { route: "A" } }]);
  });
});
