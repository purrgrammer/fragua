// GraphView tests — the AI-Elements / @xyflow/react path.
//
// Pre-P5.13 this file exercised the server-rendered SVG injection. Those
// cases are gone: the SVG route + `getPipelineGraph()` API surface were
// deleted. What we assert now:
//
//   - `toFlowGraph()` (the pure transform) produces one FlowEdge per
//     edge declared in the DOT source, anchored to the right source/
//     target ids. This is the regression test for "GraphView stopped
//     drawing edges" — the transform is the single source of truth and
//     asserting on it sidesteps React-Flow's happy-dom layout gap.
//   - Rendered output carries a `data-node-id` attribute per graph node
//     (happy-dom CAN mount the custom Node component) so Playwright /
//     unit tests targeting specific nodes keep working.
//   - Lifecycle state flows through to `data-state` on each node.
//   - With no workflowSource the component renders the purpose-built
//     empty state rather than crashing.
//   - `onNodeClick` fires with the clicked node id.
//
// Why we don't assert on `.react-flow__edge` DOM nodes: happy-dom can't
// compute layout (no getBoundingClientRect values), and React-Flow
// short-circuits edge rendering when source/target rects are zero. The
// `toFlowGraph` unit test above covers the data path; visual regressions
// get caught by the running dev server + Playwright (future).

import { afterEach, describe, expect, it } from "bun:test";
import { parseDotSource } from "@swarm/core";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { GraphView, toFlowGraph } from "../../src/components/GraphView.tsx";
import type { PipelineDetail } from "../../src/lib/api.ts";
import { renderWithClient as render } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

const WORKFLOW_SOURCE = `digraph demo {
  graph [ label = "demo" ]
  start [shape=Mdiamond, label="start"]
  middle [shape=box, label="middle"]
  done [shape=Msquare, label="done"]
  start -> middle
  middle -> done
}`;

function makeDetail(overrides: Partial<PipelineDetail> = {}): PipelineDetail {
  return {
    runId: "r1",
    startedAt: "2024-01-01T00:00:00.000Z",
    status: "running",
    lastEventSeq: 2,
    nodes: [
      { nodeId: "start", state: "completed", lastEventSeq: 1 },
      { nodeId: "middle", state: "running", lastEventSeq: 2 },
    ],
    workflowSource: WORKFLOW_SOURCE,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

describe("toFlowGraph — pure transform", () => {
  it("emits one FlowEdge per DOT edge, anchored to correct source/target", () => {
    const graph = parseDotSource(WORKFLOW_SOURCE);
    const { flowEdges, flowNodes } = toFlowGraph(makeDetail(), graph);

    // Both edges present, in source order.
    expect(flowEdges.length).toBe(2);
    expect(flowEdges[0]).toMatchObject({ source: "start", target: "middle" });
    expect(flowEdges[1]).toMatchObject({ source: "middle", target: "done" });

    // Every edge endpoint has a corresponding node in flowNodes.
    const nodeIds = new Set(flowNodes.map((n) => n.id));
    for (const e of flowEdges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
  });

  it("unions graph.nodes with detail.nodes so DOT-only nodes still render as pending", () => {
    const graph = parseDotSource(WORKFLOW_SOURCE);
    const { flowNodes } = toFlowGraph(makeDetail(), graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { state: string; label?: string }]));
    // `done` is only in topology (no lifecycle event yet).
    expect(byId.get("done")?.state).toBe("pending");
    expect(byId.get("start")?.state).toBe("completed");
    expect(byId.get("middle")?.state).toBe("running");
    // Labels come from DOT attrs.
    expect(byId.get("done")?.label).toBe("done");
  });

  it("marks the activeNodeId entry as active", () => {
    const graph = parseDotSource(WORKFLOW_SOURCE);
    const { flowNodes } = toFlowGraph(makeDetail(), graph, { activeNodeId: "middle" });
    const active = flowNodes.find((n) => n.id === "middle")?.data as { active: boolean };
    expect(active.active).toBe(true);
    const other = flowNodes.find((n) => n.id === "start")?.data as { active: boolean };
    expect(other.active).toBe(false);
  });
});

describe("GraphView — rendering", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders a data-node-id per DOT node", async () => {
    const { container } = render(<GraphView detail={makeDetail()} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const nodeAnchors = canvas.querySelectorAll("[data-node-id]");
    const ids = new Set(Array.from(nodeAnchors).map((el) => el.getAttribute("data-node-id")));
    expect(ids.has("start")).toBe(true);
    expect(ids.has("middle")).toBe(true);
    expect(ids.has("done")).toBe(true);
  });

  it("stamps data-state on each node so callers can style by lifecycle", async () => {
    const { container } = render(<GraphView detail={makeDetail()} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const byId = new Map(
      Array.from(canvas.querySelectorAll("[data-node-id]")).map((el) => [
        el.getAttribute("data-node-id"),
        el.getAttribute("data-state"),
      ]),
    );
    expect(byId.get("start")).toBe("completed");
    expect(byId.get("middle")).toBe("running");
    expect(byId.get("done")).toBe("pending");
  });

  it("shows the purpose-built empty state when workflowSource is absent", () => {
    const detail = makeDetail();
    const withoutSource: PipelineDetail = { ...detail, workflowSource: undefined };
    const { container } = render(<GraphView detail={withoutSource} />);
    const empty = within(container).getByTestId("graphview-nograph");
    expect(empty.textContent ?? "").toMatch(/No graph available/i);
    expect(container.querySelector("[data-testid='graphview']")).toBeNull();
  });

  it("fires onNodeClick with the clicked node id", async () => {
    const clicks: string[] = [];
    const { container } = render(<GraphView detail={makeDetail()} onNodeClick={(id) => clicks.push(id)} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const startNode = canvas.querySelector('.react-flow__node[data-id="start"]');
    expect(startNode).toBeTruthy();
    fireEvent.click(startNode as Element);
    expect(clicks).toEqual(["start"]);
  });
});

describe("toFlowGraph — layout + metadata", () => {
  it("default orientation is top-to-bottom (depth drives y, siblings spread on x)", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box]
      b [shape=box]
      done [shape=Msquare]
      start -> a -> done
      start -> b -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(makeDetail({ workflowSource: src, nodes: [] }), graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.position]));
    const start = byId.get("start");
    const done = byId.get("done");
    expect(start).toBeDefined();
    expect(done).toBeDefined();
    // Top-to-bottom: `done` sits BELOW `start` (greater y), same x axis range.
    expect((done?.y ?? 0) > (start?.y ?? 0)).toBe(true);
  });

  it("LR orientation swaps axes (depth drives x)", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(makeDetail({ workflowSource: src, nodes: [] }), graph, { orientation: "LR" });
    const byId = new Map(flowNodes.map((n) => [n.id, n.position]));
    const start = byId.get("start");
    const done = byId.get("done");
    expect((done?.x ?? 0) > (start?.x ?? 0)).toBe(true);
  });

  it("loop (trapezium) nodes carry an iteration label", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      loop [shape=trapezium, max_iterations=3, until="APPROVED", label="implement and review"]
      done [shape=Msquare]
      start -> loop -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const loopData = flowNodes.find((n) => n.id === "loop")?.data as {
      iterationLabel?: string;
      handler: string;
    };
    expect(loopData.handler).toBe("loop");
    expect(loopData.iterationLabel).toBe("×3 iterations");
  });

  it("non-loop nodes have no iteration label", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box]
      start -> a
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const aData = flowNodes.find((n) => n.id === "a")?.data as { iterationLabel?: string };
    expect(aData.iterationLabel).toBeUndefined();
  });

  it("surfaces the model attribute in the node data", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box, model="claude-sonnet-4-5"]
      start -> a
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const aData = flowNodes.find((n) => n.id === "a")?.data as { model?: string };
    expect(aData.model).toBe("claude-sonnet-4-5");
  });

  it("static mode (null detail) emits nodes with state=null and non-animated edges", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes, flowEdges } = toFlowGraph(null, graph);
    expect(flowNodes.every((n) => (n.data as { state: unknown }).state === null)).toBe(true);
    expect(flowEdges.every((e) => (e.data as { animated: boolean }).animated === false)).toBe(true);
  });

  it("selectedNodeId flag flows to the selected node", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      done [shape=Msquare]
      start -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph, { selectedNodeId: "done" });
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { selected: boolean }]));
    expect(byId.get("done")?.selected).toBe(true);
    expect(byId.get("start")?.selected).toBe(false);
  });
});
