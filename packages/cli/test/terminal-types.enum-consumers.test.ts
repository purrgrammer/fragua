// enum-consumers gate for the follow/tail terminal set. `run follow` /
// `runs tail` stop when they see a terminal fact; the set they watch derives
// from `@fragua/types`' `TERMINAL_FACT_TYPES` (folded out of the settled-status
// → terminal-fact source of truth). This suite is the CLI-side belt: it drives
// `followRun` with each member of that set and asserts the loop actually stops,
// so a new terminal fact type can never re-introduce the "hang forever on a
// finished run" bug without failing here.

import { describe, expect, test } from "bun:test";
import type { StoredEvent } from "@fragua/store";
import { TERMINAL_FACT_TYPES } from "@fragua/types";
import { followRun } from "../src/run-follow.ts";
import type { StoreClient } from "../src/store-client.ts";

const RUN_ID = "r";

/** A client whose log is a single terminal fact — if the follow loop doesn't
 * treat it as terminal, `followRun` polls forever and the test times out. */
function terminalOnlyClient(type: string): StoreClient {
  const done: StoredEvent = { runId: RUN_ID, seq: 1, type, writer: "daemon", payload: {}, ts: 1 };
  return {
    readPlane: {
      eventsSince: (_runId: string, sinceSeq: number, limit?: number) =>
        [done].filter((e) => e.seq > sinceSeq).slice(0, limit ?? 1),
    },
  } as unknown as StoreClient;
}

describe("followRun — terminal fact coverage", () => {
  test("stops on every member of TERMINAL_FACT_TYPES (no hang on a finished run)", async () => {
    expect(TERMINAL_FACT_TYPES.size).toBeGreaterThan(0);
    for (const type of TERMINAL_FACT_TYPES) {
      // Returns => the loop recognised the fact as terminal; a stale set would
      // fall through to the poll and this test would time out instead.
      const code = await followRun(terminalOnlyClient(type), RUN_ID);
      expect(typeof code).toBe("number");
    }
  }, 3000);

  test("fact.run_terminated and fact.run_quarantined are the terminal facts", () => {
    // Both-direction pin. Adding a terminal fact type here without adding it to
    // the source of truth (and thus to TERMINAL_FACT_TYPES) fails this check.
    expect(TERMINAL_FACT_TYPES).toEqual(new Set(["fact.run_terminated", "fact.run_quarantined"]));
  });
});
