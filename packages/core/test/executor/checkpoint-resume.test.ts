// Wave 6 — checkpoint + resume end-to-end. Uses an in-memory
// CheckpointStore so the test stays hermetic; the filesystem adapter
// is exercised in @swarm/events tests separately.

import { describe, expect, test } from "bun:test";
import type { Checkpoint, CheckpointStore } from "../../src/index.ts";
import { type CodergenInput, execute, MockCodergenBackend, parseDotSource } from "../../src/index.ts";
import { ok } from "../../src/types/outcome.ts";

function memoryCheckpointStore(): CheckpointStore & { snapshots: Map<string, Checkpoint> } {
  const snapshots = new Map<string, Checkpoint>();
  return {
    snapshots,
    async save(runId: string, snapshot: Checkpoint): Promise<void> {
      snapshots.set(runId, snapshot);
    },
    async load(runId: string): Promise<Checkpoint | undefined> {
      return snapshots.get(runId);
    },
  };
}

const GRAPH = `
  digraph {
    s [shape=Mdiamond]
    a [prompt="first",  fidelity="full"]
    b [prompt="second", fidelity="full"]
    c [prompt="third",  fidelity="full"]
    done [shape=Msquare]
    s -> a -> b -> c -> done
  }
`;

describe("checkpoint + resume — Wave 6 end-to-end", () => {
  test("save on each node; resume after mid-run abort seeks to last-saved current_node", async () => {
    const store = memoryCheckpointStore();
    const runId = "run-checkpoint-1";
    // Simulate a crash mid-run: abort the signal once "a" completes,
    // so the checkpoint's last saved current_node is "a" and the
    // executor never reaches b/c.
    const abort = new AbortController();
    const firstVisits: string[] = [];
    const res1 = await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      checkpointStore: store,
      signal: abort.signal,
      backend: new MockCodergenBackend((input: CodergenInput) => {
        firstVisits.push(input.node.id);
        if (input.node.id === "a") {
          abort.abort();
          return ok({ notes: "a done", context_updates: { "visited.a": true } });
        }
        return ok();
      }),
    });
    expect(res1.outcome.status).toBe("fail");
    const saved = store.snapshots.get(runId);
    expect(saved).toBeDefined();
    expect(saved!.completed_nodes).toContain("a");
    expect(saved!.context["visited.a"]).toBe(true);
    // After abort, b/c never ran.
    expect(firstVisits).not.toContain("b");

    // Resume: picks up from saved.current_node forward.
    const resumeVisits: string[] = [];
    const res2 = await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      checkpointStore: store,
      resume: true,
      backend: new MockCodergenBackend((input: CodergenInput) => {
        resumeVisits.push(input.node.id);
        return ok({ notes: `${input.node.id} done (resume)` });
      }),
    });
    expect(res2.outcome.status).toBe("success");
    // "a" had already completed pre-abort — does NOT re-run; "b" and
    // "c" do, since the resume started from the saved current_node.
    expect(resumeVisits).not.toContain("a");
    expect(resumeVisits).toContain("b");
    expect(resumeVisits).toContain("c");
  });

  test("resume=true with no saved checkpoint is a silent no-op", async () => {
    const store = memoryCheckpointStore();
    const runId = "fresh-run";
    const visits: string[] = [];
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      checkpointStore: store,
      resume: true,
      backend: new MockCodergenBackend((input) => {
        visits.push(input.node.id);
        return ok();
      }),
    });
    // Fresh run: every codergen node runs once.
    expect(visits).toEqual(["a", "b", "c"]);
    // A checkpoint now exists (save happens on every completed node).
    expect(store.snapshots.has(runId)).toBe(true);
  });

  test("resume applies degradeOnResume to the first resumed node's fidelity (SPEC §3.6)", async () => {
    const store = memoryCheckpointStore();
    const runId = "degrade-run";
    // Crash after "a" completes so the checkpoint's current_node is
    // "a" — the resumed call on "a" must have its fidelity degraded
    // from full → summary:high.
    const abort = new AbortController();
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      checkpointStore: store,
      signal: abort.signal,
      backend: new MockCodergenBackend((input) => {
        if (input.node.id === "a") abort.abort();
        return ok();
      }),
    });

    const observedFidelities: Array<{ nodeId: string; fidelity: string }> = [];
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      checkpointStore: store,
      resume: true,
      backend: new MockCodergenBackend((input) => {
        observedFidelities.push({ nodeId: input.node.id, fidelity: input.fidelity });
        return ok();
      }),
    });
    // First resumed codergen call: fidelity was `full` on node a/b/c;
    // the resumed one degrades to summary:high. Subsequent nodes stay
    // at their declared fidelity.
    expect(observedFidelities.length).toBeGreaterThanOrEqual(1);
    expect(observedFidelities[0]!.fidelity).toBe("summary:high");
    // Every subsequent node runs at its declared fidelity unchanged.
    for (const ob of observedFidelities.slice(1)) {
      expect(ob.fidelity).toBe("full");
    }
  });
});
