// Tests for the `swarm dashboard` TUI primitives. We deliberately avoid
// rendering through Ink: all the logic we care about (ASCII layout, node
// state folding, key dispatch) lives in pure functions. That keeps the
// test fast and deterministic in CI where there is no TTY.

import { describe, expect, test } from "bun:test";
import type { Event } from "@swarm/core";
import { parseDotSource } from "@swarm/core";
import { renderAsciiGraph } from "../src/ui/AsciiGraph.tsx";
import { dispatchKey } from "../src/ui/KeyHandler.ts";
import { activeNodeId, buildNodeStates, foldNodeState } from "../src/ui/node-state.ts";

const FIXTURE_DOT = `digraph demo {
  start [shape=Mdiamond, label="start"]
  work  [shape=box,      label="work"]
  done  [shape=Msquare,  label="done"]
  start -> work
  work  -> done
}`;

describe("renderAsciiGraph — small fixture (3 nodes, 2 edges)", () => {
  const graph = parseDotSource(FIXTURE_DOT);

  test("produces a deterministic ASCII block with one box per node", () => {
    const { lines, nodeBoxes } = renderAsciiGraph(graph, new Map(), null);
    // Three boxes, top-down ordering by depth.
    expect(nodeBoxes.map((b) => b.nodeId).sort()).toEqual(["done", "start", "work"]);
    // Every box id must appear somewhere in the rendered lines.
    const block = lines.join("\n");
    for (const id of ["start", "work", "done"]) {
      expect(block.includes(id)).toBe(true);
    }
    // Box-drawing glyphs are present (we don't check exact geometry here
    // — that lives in the snapshot below).
    expect(block).toContain("┌");
    expect(block).toContain("└");
    expect(block).toContain("│");
  });

  test("snapshot — full ASCII block for the 3-node fixture", () => {
    const { lines } = renderAsciiGraph(graph, new Map(), null);
    // Keep the snapshot inline so it's visible in the test source — if
    // the ASCII shifts we see the diff here instead of hunting through
    // a separate fixtures dir.
    expect(lines).toMatchSnapshot();
  });

  test("is stable across repeated renders with the same inputs", () => {
    const a = renderAsciiGraph(graph, new Map(), null).lines;
    const b = renderAsciiGraph(graph, new Map(), null).lines;
    expect(a).toEqual(b);
  });
});

describe("node-state reducer", () => {
  test("folds a canonical event stream into the expected highlight", () => {
    const events: Event[] = [
      ev("pipeline.started", null, {}),
      ev("node.started", "start", {}),
      ev("node.completed", "start", { outcome: { status: "pass" } }),
      ev("node.started", "work", {}),
    ];
    const states = buildNodeStates(events);
    expect(states.get("start")?.state).toBe("completed");
    expect(states.get("work")?.state).toBe("running");
    // The "active" node (most recently running) is `work`.
    expect(activeNodeId(states)).toBe("work");
  });

  test("node.completed with outcome.status='fail' flips to failed", () => {
    const states = new Map();
    foldNodeState(states, ev("node.started", "a", {}), 1);
    foldNodeState(states, ev("node.completed", "a", { outcome: { status: "fail" } }), 2);
    expect(states.get("a")?.state).toBe("failed");
  });

  test("node.retrying / skipped / failed map through correctly", () => {
    const states = new Map();
    foldNodeState(states, ev("node.started", "a", {}), 1);
    foldNodeState(states, ev("node.retrying", "a", { attempt: 1, max_retries: 3 }), 2);
    expect(states.get("a")?.state).toBe("retrying");
    foldNodeState(states, ev("node.failed", "a", { reason: "x" }), 3);
    expect(states.get("a")?.state).toBe("failed");
    foldNodeState(states, ev("node.skipped", "b", {}), 4);
    expect(states.get("b")?.state).toBe("skipped");
  });

  test("events without node_id are ignored (pipeline lifecycle)", () => {
    const states = new Map();
    foldNodeState(states, ev("pipeline.started", null, {}), 1);
    foldNodeState(states, ev("pipeline.completed", null, {}), 2);
    expect(states.size).toBe(0);
    expect(activeNodeId(states)).toBeUndefined();
  });
});

describe("AsciiGraph state-driven highlight", () => {
  test("active node is reported in nodeBoxes for the Ink colour pass", () => {
    const graph = parseDotSource(FIXTURE_DOT);
    const states = buildNodeStates([
      ev("node.started", "start", {}),
      ev("node.completed", "start", { outcome: { status: "pass" } }),
      ev("node.started", "work", {}),
    ]);
    const { nodeBoxes } = renderAsciiGraph(graph, states, "work");
    // Every node in the DOT still has a box — highlighting is applied
    // at the render layer, so the box geometry itself is unchanged.
    const ids = nodeBoxes.map((b) => b.nodeId).sort();
    expect(ids).toEqual(["done", "start", "work"]);
    // The state reducer should agree that `work` is active.
    expect(activeNodeId(states)).toBe("work");
    expect(states.get("start")?.state).toBe("completed");
    expect(states.get("work")?.state).toBe("running");
  });
});

describe("dispatchKey — TUI keybindings", () => {
  const mkHandlers = () => {
    const calls: string[] = [];
    return {
      calls,
      handlers: {
        onSteer: () => calls.push("steer"),
        onAbort: () => calls.push("abort"),
        onQuit: () => calls.push("quit"),
      },
    };
  };

  test("'s' opens the steering prompt", () => {
    const { calls, handlers } = mkHandlers();
    const result = dispatchKey("s", {}, handlers);
    expect(result).toBe("steer");
    expect(calls).toEqual(["steer"]);
  });

  test("'a' triggers the abort handler", () => {
    const { calls, handlers } = mkHandlers();
    const result = dispatchKey("a", {}, handlers);
    expect(result).toBe("abort");
    expect(calls).toEqual(["abort"]);
  });

  test("'q' quits", () => {
    const { calls, handlers } = mkHandlers();
    const result = dispatchKey("q", {}, handlers);
    expect(result).toBe("quit");
    expect(calls).toEqual(["quit"]);
  });

  test("Escape quits", () => {
    const { calls, handlers } = mkHandlers();
    const result = dispatchKey("", { escape: true }, handlers);
    expect(result).toBe("quit");
    expect(calls).toEqual(["quit"]);
  });

  test("Ctrl-C quits", () => {
    const { calls, handlers } = mkHandlers();
    const result = dispatchKey("c", { ctrl: true }, handlers);
    expect(result).toBe("quit");
    expect(calls).toEqual(["quit"]);
  });

  test("uppercase letters still match (shift is tolerated)", () => {
    const { calls, handlers } = mkHandlers();
    dispatchKey("S", { shift: true }, handlers);
    dispatchKey("A", { shift: true }, handlers);
    dispatchKey("Q", { shift: true }, handlers);
    expect(calls).toEqual(["steer", "abort", "quit"]);
  });

  test("modifier-held bare letters are ignored (Ctrl-S etc. left to the terminal)", () => {
    const { calls, handlers } = mkHandlers();
    expect(dispatchKey("s", { ctrl: true }, handlers)).toBeUndefined();
    expect(dispatchKey("a", { meta: true }, handlers)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  test("unknown keys do nothing", () => {
    const { calls, handlers } = mkHandlers();
    expect(dispatchKey("x", {}, handlers)).toBeUndefined();
    expect(dispatchKey("", {}, handlers)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

function ev<T extends Event["type"]>(type: T, nodeId: string | null, data: Record<string, unknown>): Event {
  return {
    schema_version: 1,
    run_id: "test-run",
    timestamp: "2025-01-01T00:00:00.000Z",
    type,
    ...(nodeId !== null ? { node_id: nodeId } : {}),
    data,
  } as unknown as Event;
}
