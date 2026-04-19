// Control channel — restart-safety + idempotency.
//
// Contract: when a run resumes from a checkpoint that already reflects
// prior control requests (via `last_applied_control_id`), the executor
// must NOT re-apply those requests even though the full control.jsonl
// file is re-tailed from the top.
//
// The tail is file-position-agnostic by design — the control file is
// append-only and strictly ordered, so "last applied id" is equivalent
// to "position". The loop skips every request up to and including the
// marker id, then applies everything after.

import { describe, expect, test } from "bun:test";
import type { Checkpoint, CheckpointStore, CodergenBackend, ControlRequest } from "../../src/index.ts";
import { execute, InMemorySink, parseDotSource } from "../../src/index.ts";
import { ok } from "../../src/types/outcome.ts";

/** Mock backend that supports `steer` so tests can exercise the applied
 * path. The default `MockCodergenBackend` intentionally omits steer. */
function steerableMockBackend(): CodergenBackend & { steers: string[] } {
  const steers: string[] = [];
  return {
    steers,
    async run() {
      return ok({ notes: "ok" });
    },
    steer(msg: string) {
      steers.push(msg);
    },
  };
}

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

function makeControlChannel(seed: ControlRequest[]): {
  push: (r: ControlRequest) => void;
  tail: (path: string, opts: { signal: AbortSignal }) => AsyncIterable<ControlRequest>;
} {
  const queue: ControlRequest[] = [...seed];
  let notify: (() => void) | undefined;
  const push = (r: ControlRequest) => {
    queue.push(r);
    notify?.();
    notify = undefined;
  };
  const tail = async function* (_path: string, opts: { signal: AbortSignal }): AsyncIterable<ControlRequest> {
    while (!opts.signal.aborted) {
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      await new Promise<void>((resolve) => {
        notify = resolve;
        opts.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
  return { push, tail };
}

function req(id: string, command: ControlRequest["command"], payload?: ControlRequest["payload"]): ControlRequest {
  return {
    id,
    timestamp: "2026-04-17T00:00:00Z",
    command,
    ...(payload !== undefined ? { payload } : {}),
  };
}

const GRAPH = `
  digraph {
    s [shape=Mdiamond]
    a [prompt="a"]
    b [prompt="b"]
    done [shape=Msquare]
    s -> a -> b -> done
  }
`;

describe("control channel — restart-safety + idempotency", () => {
  test("requests reflected in checkpoint's last_applied_control_id are skipped on resume", async () => {
    const store = memoryCheckpointStore();
    const runId = "run-idempo-1";

    // Run 1: one steer request. It lands and checkpoint advances.
    const run1Sink = new InMemorySink();
    const run1 = makeControlChannel([req("ctl-1", "steer", { message: "first" })]);
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      sink: run1Sink,
      backend: steerableMockBackend(),
      checkpointStore: store,
      controlChannel: { path: "/dev/null", tail: run1.tail },
    });

    // Verify the first run did apply ctl-1 and the checkpoint captured it.
    const applied1 = run1Sink.byType("control.applied");
    expect(applied1.map((e) => e.data["id"])).toContain("ctl-1");
    const snap = store.snapshots.get(runId);
    expect(snap?.last_applied_control_id).toBe("ctl-1");

    // Run 2 (resume): the control tail yields the SAME ctl-1 (the file
    // wasn't truncated) plus a new ctl-2. Only ctl-2 should land in the
    // new sink — ctl-1 is already reflected in the prior event stream.
    const run2Sink = new InMemorySink();
    const run2 = makeControlChannel([
      req("ctl-1", "steer", { message: "first" }),
      req("ctl-2", "steer", { message: "second" }),
    ]);
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      sink: run2Sink,
      backend: steerableMockBackend(),
      checkpointStore: store,
      resume: true,
      controlChannel: { path: "/dev/null", tail: run2.tail },
    });

    const requested2 = run2Sink.byType("control.requested").map((e) => e.data["id"]);
    const applied2 = run2Sink.byType("control.applied").map((e) => e.data["id"]);
    expect(requested2).toEqual(["ctl-2"]);
    expect(applied2).toEqual(["ctl-2"]);
  });

  test("a duplicate id appended after the marker is treated as a NEW request (idempotency is about position, not content)", async () => {
    // This documents the non-invariant: ids are NOT globally dedup'd;
    // they're markers for "where did we leave off". If a client
    // re-submits a request with the same id AFTER the marker, it still
    // lands. Clients should use fresh uuids per request (the CLI does).
    const store = memoryCheckpointStore();
    const runId = "run-idempo-2";

    // First run: ctl-1 applied.
    const s1 = new InMemorySink();
    const c1 = makeControlChannel([req("ctl-1", "steer", { message: "first" })]);
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      sink: s1,
      backend: steerableMockBackend(),
      checkpointStore: store,
      controlChannel: { path: "/dev/null", tail: c1.tail },
    });

    // Resume with ctl-1 (already applied) then another ctl-1 (would be
    // *after* the marker position — the loop skips the first match then
    // applies the rest). Real-world this shouldn't happen (uuids are
    // unique) but the contract must be explicit.
    const s2 = new InMemorySink();
    const c2 = makeControlChannel([
      req("ctl-1", "steer", { message: "first" }),
      req("ctl-1", "steer", { message: "duplicate id" }),
    ]);
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      sink: s2,
      backend: steerableMockBackend(),
      checkpointStore: store,
      resume: true,
      controlChannel: { path: "/dev/null", tail: c2.tail },
    });
    // The second ctl-1 is *after* the marker, so it applies. The first
    // (marker match) is skipped.
    const applied = s2.byType("control.applied").filter((e) => e.data["command"] === "steer");
    expect(applied.length).toBe(1);
    expect((applied[0]!.data["payload"] as { message: string } | undefined)?.message).toBeUndefined();
  });

  test("dedup marker survives two restarts (resume → crash → resume again)", async () => {
    // Adversarial: the executor may resume, advance the marker, then
    // crash before finishing. On the second resume the control tail
    // yields the full file again — both already-applied ids must be
    // skipped, and only the tail-most request should land.
    const store = memoryCheckpointStore();
    const runId = "run-double-restart";

    // Run 1: apply ctl-1. Checkpoint marker advances to ctl-1.
    const s1 = new InMemorySink();
    const c1 = makeControlChannel([req("ctl-1", "steer", { message: "one" })]);
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      sink: s1,
      backend: steerableMockBackend(),
      checkpointStore: store,
      controlChannel: { path: "/dev/null", tail: c1.tail },
    });
    expect(store.snapshots.get(runId)?.last_applied_control_id).toBe("ctl-1");

    // Run 2 (resume): replay yields ctl-1 again, plus new ctl-2. Only
    // ctl-2 lands. Marker advances to ctl-2.
    const s2 = new InMemorySink();
    const c2 = makeControlChannel([
      req("ctl-1", "steer", { message: "one" }),
      req("ctl-2", "steer", { message: "two" }),
    ]);
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      sink: s2,
      backend: steerableMockBackend(),
      checkpointStore: store,
      resume: true,
      controlChannel: { path: "/dev/null", tail: c2.tail },
    });
    expect(s2.byType("control.applied").map((e) => e.data["id"])).toEqual(["ctl-2"]);
    expect(store.snapshots.get(runId)?.last_applied_control_id).toBe("ctl-2");

    // Run 3 (second resume after simulated crash): replay yields
    // ctl-1, ctl-2, ctl-3. Marker (now ctl-2) must skip the first
    // two; only ctl-3 lands.
    const s3 = new InMemorySink();
    const c3 = makeControlChannel([
      req("ctl-1", "steer", { message: "one" }),
      req("ctl-2", "steer", { message: "two" }),
      req("ctl-3", "steer", { message: "three" }),
    ]);
    await execute({
      graph: parseDotSource(GRAPH),
      run_id: runId,
      sink: s3,
      backend: steerableMockBackend(),
      checkpointStore: store,
      resume: true,
      controlChannel: { path: "/dev/null", tail: c3.tail },
    });
    expect(s3.byType("control.applied").map((e) => e.data["id"])).toEqual(["ctl-3"]);
    expect(s3.byType("control.requested").map((e) => e.data["id"])).toEqual(["ctl-3"]);
  });
});
