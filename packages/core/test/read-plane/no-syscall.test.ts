// The read plane is a pure projection over run_state + the event log. A
// `node:fs` sync call buried in `runDetail` fans a hidden blocking syscall
// out to every read client. This pins that: a `runDetail` for a run WITH a
// `cwd` set (the case that previously probed the worktree dir on disk) issues
// no `existsSync` / `statSync` / `readFileSync`.

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as nodeFs from "node:fs";
import { newRunId, SqliteStore } from "@fragua/store";
import { CURRENT_IR_VERSION, serializeGraph } from "../../src/ir.ts";
import { parseWorkflow } from "../../src/parser/yaml.ts";
import { makeReadPlane } from "../../src/read-plane/plane.ts";

const WF_SOURCE = "name: t\nsteps:\n  work: {type: llm, prompt: x, next: exit}\n";
const WF_SHA = "nosyscall-wf";

const spies = [spyOn(nodeFs, "existsSync"), spyOn(nodeFs, "statSync"), spyOn(nodeFs, "readFileSync")] as const;

afterEach(() => {
  for (const s of spies) s.mockClear();
});

describe("readPlane.runDetail — purity", () => {
  test("issues no node:fs syscall for a run with a cwd set", () => {
    const store = new SqliteStore({ path: ":memory:" });
    store.saveWorkflow(WF_SHA, "t", WF_SOURCE, serializeGraph(parseWorkflow(WF_SOURCE)), CURRENT_IR_VERSION);
    const runId = newRunId();
    store.enqueueRun({ runId, workflowSha: WF_SHA, cwd: "/tmp/fragua-nosyscall-probe" });
    const plane = makeReadPlane({ store });

    for (const s of spies) s.mockClear();
    const detail = plane.runDetail(runId);
    expect(detail).not.toBeNull();
    expect(detail!.worktreePath).toBeUndefined();
    for (const s of spies) expect(s).not.toHaveBeenCalled();

    store.close();
  });
});
