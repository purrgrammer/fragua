// GraphView tests — the AI-Elements / @xyflow/react path.
//
// Pre-P5.13 this file exercised the server-rendered SVG injection. Those
// cases are gone: the SVG route + `getRunGraph()` API surface were
// deleted. What we assert now:
//
//   - `toFlowGraph()` (the pure transform) produces one FlowEdge per
//     edge declared in the DOT source, including edges that touch
//     start/exit terminals — terminals stay visible because labelled
//     exit edges like `verify -> done [condition="outcome=fail"]`
//     carry meaning.
//   - Rendered output carries a `data-node-id` attribute per graph node
//     (happy-dom CAN mount the custom Node component) so Playwright /
//     unit tests targeting specific nodes keep working.
//   - Lifecycle state flows through to `data-state` on each node.
//   - Back-edges (target at an earlier layout depth than source) are
//     marked `isBackEdge` so the edge renderer picks the Loop variant.
//   - Edge `condition` / `label` DOT attrs surface as edge.data.label so
//     operators can tell branching edges apart without opening the
//     inspector.
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
import type { RunDetail } from "../../src/lib/api.ts";
import { parseAndPrepare } from "../../src/lib/parse-workflow.ts";
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

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    runId: "r1",
    startedAt: "2024-01-01T00:00:00.000Z",
    status: "running",
    lastEventSeq: 2,
    nodes: [
      { nodeId: "start", iteration: 0, state: "completed", lastEventSeq: 1 },
      { nodeId: "middle", iteration: 0, state: "running", lastEventSeq: 2 },
    ],
    selectedEdges: [{ from: "start", to: "middle", iteration: 0 }],
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

  it("every edge carries a markerEnd so direction is unambiguous", () => {
    const graph = parseDotSource(WORKFLOW_SOURCE);
    const { flowEdges } = toFlowGraph(null, graph);
    for (const e of flowEdges) {
      expect(e.markerEnd).toBeDefined();
    }
  });
});

describe("GraphView — parallel branches", () => {
  it("branch nodes render with active styling when their state is running, and the winner gets a success accent after fan_in", () => {
    const src = `digraph g {
      fork [shape=box]
      lensA [shape=box]
      lensB [shape=box]
      sink [shape=box]
      fork -> lensA
      fork -> lensB
      lensA -> sink
      lensB -> sink
    }`;
    const graph = parseDotSource(src);

    // ——— During fan-out: parent + branches all running.
    const detailRunning = makeDetail({
      runId: "r1",
      nodes: [
        { nodeId: "fork", iteration: 0, state: "running", lastEventSeq: 1 },
        { nodeId: "lensA", iteration: 0, state: "running", lastEventSeq: 2 },
        { nodeId: "lensB", iteration: 0, state: "running", lastEventSeq: 3 },
      ],
      selectedEdges: [
        { from: "fork", to: "lensA", iteration: 0 },
        { from: "fork", to: "lensB", iteration: 0 },
      ],
      workflowSource: src,
    });
    const { flowNodes: midFlight } = toFlowGraph(detailRunning, graph, {
      activeNodeIds: new Set(["fork", "lensA", "lensB"]),
      winnerBranchIds: new Set(),
    });
    const byIdMid = new Map(
      midFlight.map((n) => [n.id, n.data as { active: boolean; winner: boolean; state: string }]),
    );
    expect(byIdMid.get("fork")?.active).toBe(true);
    expect(byIdMid.get("lensA")?.active).toBe(true);
    expect(byIdMid.get("lensB")?.active).toBe(true);
    expect(byIdMid.get("lensA")?.winner).toBe(false);
    expect(byIdMid.get("lensB")?.winner).toBe(false);
    // sink is not running → not active.
    expect(byIdMid.get("sink")?.active).toBe(false);

    // ——— After fan_in: branches completed, winner picked.
    const detailDone = makeDetail({
      runId: "r1",
      nodes: [
        { nodeId: "fork", iteration: 0, state: "completed", lastEventSeq: 1 },
        { nodeId: "lensA", iteration: 0, state: "completed", lastEventSeq: 2 },
        { nodeId: "lensB", iteration: 0, state: "completed", lastEventSeq: 3 },
      ],
      selectedEdges: [
        { from: "fork", to: "lensA", iteration: 0 },
        { from: "fork", to: "lensB", iteration: 0 },
      ],
      workflowSource: src,
    });
    const { flowNodes: postFanIn } = toFlowGraph(detailDone, graph, {
      activeNodeIds: new Set(),
      winnerBranchIds: new Set(["lensB"]),
    });
    const byIdDone = new Map(postFanIn.map((n) => [n.id, n.data as { active: boolean; winner: boolean }]));
    expect(byIdDone.get("lensA")?.winner).toBe(false);
    expect(byIdDone.get("lensB")?.winner).toBe(true);
    expect(byIdDone.get("fork")?.winner).toBe(false);
  });
});

describe("toFlowGraph — back-edge detection + edge labels", () => {
  it("marks back-edges whose target sits at an earlier depth as isBackEdge", () => {
    const src = `digraph g {
      a [shape=box]
      b [shape=box]
      c [shape=box]
      a -> b -> c
      c -> a [condition="outcome=retry"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const byPair = new Map(flowEdges.map((e) => [`${e.source}->${e.target}`, e.data as { isBackEdge?: boolean }]));
    expect(byPair.get("a->b")?.isBackEdge).toBe(false);
    expect(byPair.get("b->c")?.isBackEdge).toBe(false);
    expect(byPair.get("c->a")?.isBackEdge).toBe(true);
  });

  it("back-edges route through the side handles so they arc outside the column", () => {
    const src = `digraph g {
      a [shape=box]
      b [shape=box]
      a -> b -> a
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const back = flowEdges.find((e) => e.source === "b" && e.target === "a");
    expect(back?.sourceHandle).toBe("loop-source");
    expect(back?.targetHandle).toBe("loop-target");
    const forward = flowEdges.find((e) => e.source === "a" && e.target === "b");
    expect(forward?.sourceHandle).toBeUndefined();
    expect(forward?.targetHandle).toBeUndefined();
  });

  it("toFlowGraph attaches arcExtent to skip/back/loop edges based on intermediate-layer extent", () => {
    // Wide parallel fan: start splits into a/b/c at depth 1, all
    // converging at done (depth 2). The skip-edge `start -> done`
    // (added below) jumps from depth 0 to depth 2, so its arc has to
    // clear the layer-1 fan. arcExtent should reflect the lateral
    // extent of {a, b, c}.
    const src = `digraph fan {
      start [shape=box]
      a [shape=box]
      b [shape=box]
      c [shape=box]
      done [shape=box]
      start -> a
      start -> b
      start -> c
      a -> done
      b -> done
      c -> done
      start -> done [condition="outcome=skip"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const skip = flowEdges.find((e) => e.source === "start" && e.target === "done");
    expect(skip).toBeTruthy();
    const data = skip?.data as { isSkipEdge?: boolean; arcExtent?: number };
    expect(data?.isSkipEdge).toBe(true);
    // Three nodes at depth 1 in TB layout share crossSize=280, so the
    // outermost branches sit at ±280 from the axis. arcExtent reads
    // the max |x| (280) so the renderer can push the bulge past it.
    expect(typeof data?.arcExtent).toBe("number");
    expect(data?.arcExtent ?? 0).toBeGreaterThanOrEqual(280);

    // Forward edges that DON'T clear an intermediate layer don't get
    // an arcExtent stamped (additive optional field).
    const direct = flowEdges.find((e) => e.source === "start" && e.target === "a");
    expect(direct).toBeTruthy();
    const directData = direct?.data as { arcExtent?: number };
    expect(directData?.arcExtent).toBeUndefined();
  });

  it("strips the `outcome=` prefix from condition labels (label CSS-uppercases the rest)", () => {
    const src = `digraph g {
      a [shape=box]
      b [shape=box]
      c [shape=box]
      d [shape=box]
      a -> b [condition="outcome=success"]
      a -> c [label="fallback"]
      a -> d [condition="outcome=fail && context.severity=high"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const byPair = new Map(flowEdges.map((e) => [`${e.source}->${e.target}`, e.data as { label?: string }]));
    expect(byPair.get("a->b")?.label).toBe("success");
    expect(byPair.get("a->c")?.label).toBe("fallback");
    // Compound conditions: only the `outcome=` key gets stripped; the rest
    // of the expression is preserved verbatim so authors can still read it.
    expect(byPair.get("a->d")?.label).toBe("fail && context.severity=high");
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

  it("a running tool node renders with the active ring + thinking-pulse dot + teal handler strip", async () => {
    const src = `digraph crowdin {
      start [shape=Mdiamond]
      find_pr [shape=parallelogram, tool_command="gh pr list --head l10n_crowdin"]
      done [shape=Msquare]
      start -> find_pr -> done
    }`;
    const detail: RunDetail = {
      runId: "r-tool",
      startedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
      lastEventSeq: 2,
      nodes: [
        { nodeId: "start", iteration: 0, state: "completed", lastEventSeq: 1 },
        { nodeId: "find_pr", iteration: 0, state: "running", lastEventSeq: 2 },
      ],
      selectedEdges: [{ from: "start", to: "find_pr", iteration: 0 }],
      workflowSource: src,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    const { container } = render(<GraphView detail={detail} activeNodeIds={new Set(["find_pr"])} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const node = canvas.querySelector('[data-node-id="find_pr"]') as HTMLElement | null;
    expect(node).toBeTruthy();
    // Stamped attributes for downstream styling / debugging.
    expect(node?.getAttribute("data-state")).toBe("running");
    expect(node?.getAttribute("data-handler")).toBe("tool");

    // Active ring is on the card itself.
    const cls = node?.getAttribute("class") ?? "";
    expect(cls).toContain("ring-sw-accent-thinking");

    // Tool handler-strip uses the loop tone (teal).
    const strip = node?.querySelector(".bg-sw-accent-loop");
    expect(strip).toBeTruthy();

    // StateDot pulses with the thinking accent while running.
    const dots = node?.querySelectorAll(".bg-sw-accent-thinking") ?? [];
    expect(dots.length).toBeGreaterThan(0);
    const pulsing = Array.from(dots).some((el) => el.className.includes("sw-pulse"));
    expect(pulsing).toBe(true);
  });

  it("shows the purpose-built empty state when workflowSource is absent", () => {
    const detail = makeDetail();
    const withoutSource: RunDetail = { ...detail, workflowSource: undefined };
    const { container } = render(<GraphView detail={withoutSource} />);
    const empty = within(container).getByTestId("graphview-nograph");
    expect(empty.textContent ?? "").toMatch(/No graph available/i);
    expect(container.querySelector("[data-testid='graphview']")).toBeNull();
  });

  it("renders start and exit nodes in a compact form (header only, no metadata rows)", async () => {
    const { container } = render(<GraphView detail={makeDetail()} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const start = canvas.querySelector('[data-node-id="start"]') as HTMLElement | null;
    const done = canvas.querySelector('[data-node-id="done"]') as HTMLElement | null;
    const middle = canvas.querySelector('[data-node-id="middle"]') as HTMLElement | null;
    expect(start).toBeTruthy();
    expect(done).toBeTruthy();
    expect(middle).toBeTruthy();

    // Compact marker on lifecycle terminals only.
    expect(start?.getAttribute("data-compact")).toBe("true");
    expect(done?.getAttribute("data-compact")).toBe("true");
    expect(middle?.getAttribute("data-compact")).toBeNull();

    // Terminals drop the metadata body — no `id` / `model` / `effort` rows.
    const wStart = within(start as HTMLElement);
    const wDone = within(done as HTMLElement);
    expect(wStart.queryByText("id")).toBeNull();
    expect(wStart.queryByText("model")).toBeNull();
    expect(wStart.queryByText("effort")).toBeNull();
    expect(wDone.queryByText("id")).toBeNull();

    // Regular box node still surfaces the id row — regression guard.
    const wMiddle = within(middle as HTMLElement);
    expect(wMiddle.getByText("id")).toBeTruthy();

    // Header still anchors on the name.
    expect(wStart.getAllByText("start").length).toBeGreaterThan(0);
  });

  it("terminal nodes render at the same width as regular nodes (column flush)", async () => {
    // Regression: terminals used to render at w-44 vs. w-60 for regular
    // nodes, breaking the column gridline. Width is now unified; the
    // header-only compact body is preserved via `data-compact`.
    const { container } = render(<GraphView detail={makeDetail()} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const start = canvas.querySelector('[data-node-id="start"]') as HTMLElement | null;
    const middle = canvas.querySelector('[data-node-id="middle"]') as HTMLElement | null;
    expect(start).toBeTruthy();
    expect(middle).toBeTruthy();
    const startCls = start?.getAttribute("class") ?? "";
    const middleCls = middle?.getAttribute("class") ?? "";
    expect(startCls).toContain("w-60");
    expect(middleCls).toContain("w-60");
    expect(startCls).not.toContain("w-44");
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

  it("renders model row with provider logo + effort row when attrs present", async () => {
    const src = `digraph styled {
      graph [model_stylesheet="* { llm_model: opus; llm_provider: anthropic; reasoning_effort: high; }"]
      start [shape=Mdiamond, label="start"]
      middle [shape=box, label="middle"]
      done [shape=Msquare, label="done"]
      start -> middle -> done
    }`;
    const detail: RunDetail = { ...makeDetail(), workflowSource: src };
    const { container } = render(<GraphView detail={detail} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const middle = canvas.querySelector('[data-node-id="middle"]') as HTMLElement | null;
    expect(middle).toBeTruthy();
    const w = within(middle as HTMLElement);
    expect(w.getByText("model")).toBeTruthy();
    expect(w.getByText("opus")).toBeTruthy();
    // Provider renders as a logo image inside the model row, not as a separate text row.
    expect(w.getByAltText("anthropic logo")).toBeTruthy();
    expect(w.queryByText("provider")).toBeNull();
    expect(w.getByText("effort")).toBeTruthy();
    expect(w.getByText("high")).toBeTruthy();
  });

  it("hides model/provider/effort rows when attrs absent", async () => {
    const { container } = render(<GraphView detail={makeDetail()} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const middle = canvas.querySelector('[data-node-id="middle"]') as HTMLElement | null;
    expect(middle).toBeTruthy();
    const w = within(middle as HTMLElement);
    expect(w.queryByText("model")).toBeNull();
    expect(w.queryByText("effort")).toBeNull();
    expect(w.queryByAltText(/logo$/)).toBeNull();
  });
});

describe("toFlowGraph — model_stylesheet cascade surfaces in node data", () => {
  it("wildcard rule populates model + provider + reasoningEffort on codergen nodes only", () => {
    const src = `digraph styled {
      graph [model_stylesheet="* { llm_model: opus; llm_provider: anthropic; reasoning_effort: medium; }"]
      start [shape=Mdiamond]
      a [shape=box]
      b [shape=box]
      done [shape=Msquare]
      start -> a -> b -> done
    }`;
    const graph = parseAndPrepare(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const byId = new Map(
      flowNodes.map((n) => [n.id, n.data as { model?: string; provider?: string; reasoningEffort?: string }]),
    );
    // Codergen nodes (box) pick up the cascade.
    for (const id of ["a", "b"]) {
      const d = byId.get(id);
      expect(d?.model).toBe("opus");
      expect(d?.provider).toBe("anthropic");
      expect(d?.reasoningEffort).toBe("medium");
    }
    // Lifecycle terminals never run an LLM, so the cascade values are
    // suppressed even though the parser resolved them.
    for (const id of ["start", "done"]) {
      const d = byId.get(id);
      expect(d?.model).toBeUndefined();
      expect(d?.provider).toBeUndefined();
      expect(d?.reasoningEffort).toBeUndefined();
    }
  });

  it("nodes without matching rules leave the fields undefined", () => {
    const src = `digraph plain {
      start [shape=Mdiamond]
      a [shape=box]
      done [shape=Msquare]
      start -> a -> done
    }`;
    const graph = parseAndPrepare(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const a = flowNodes.find((n) => n.id === "a")?.data as {
      model?: string;
      provider?: string;
      reasoningEffort?: string;
    };
    expect(a.model).toBeUndefined();
    expect(a.provider).toBeUndefined();
    expect(a.reasoningEffort).toBeUndefined();
  });
});

describe("toFlowGraph — metadata is gated by handler type", () => {
  // Common wildcard cascade pinned via model_stylesheet: every node ends
  // up with `llm_model` / `llm_provider` / `reasoning_effort` resolved by
  // the parser (the stylesheet allow-list excludes `thread_id`, which we
  // set directly on individual nodes when a test needs it). The point of
  // these tests is that toFlowGraph throws those values away on handlers
  // that don't run an LLM.
  const CASCADE = `model_stylesheet="* { llm_model: opus; llm_provider: anthropic; reasoning_effort: high; }"`;

  type Meta = {
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    threadId?: string;
    toolCommand?: string;
    retryTarget?: string;
    fanInTarget?: string;
    joinPolicy?: string;
    fanInRank?: string;
    maxRetries?: number;
  };

  function dataOf(src: string, id: string): Meta {
    const graph = parseAndPrepare(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const node = flowNodes.find((n) => n.id === id);
    if (!node) throw new Error(`no node ${id} in flow graph`);
    return node.data as Meta;
  }

  it("tool nodes expose toolCommand + maxRetries but not model/provider/effort/thread/retryTarget/fanIn fields", () => {
    const src = `digraph g {
      graph [${CASCADE}]
      start [shape=Mdiamond]
      run [shape=parallelogram, tool_command="bun test", max_retries=2, retry_target="start"]
      done [shape=Msquare]
      start -> run -> done
    }`;
    const d = dataOf(src, "run");
    expect(d.toolCommand).toBe("bun test");
    expect(d.maxRetries).toBe(2);
    expect(d.model).toBeUndefined();
    expect(d.provider).toBeUndefined();
    expect(d.reasoningEffort).toBeUndefined();
    expect(d.threadId).toBeUndefined();
    expect(d.retryTarget).toBeUndefined();
    expect(d.fanInTarget).toBeUndefined();
    expect(d.joinPolicy).toBeUndefined();
    expect(d.fanInRank).toBeUndefined();
  });

  it("start and exit nodes expose no LLM, tool, retry, or fan_in metadata", () => {
    const src = `digraph g {
      graph [${CASCADE}]
      start [shape=Mdiamond, max_retries=5]
      a [shape=box]
      done [shape=Msquare, max_retries=5]
      start -> a -> done
    }`;
    for (const id of ["start", "done"]) {
      const d = dataOf(src, id);
      expect(d.model).toBeUndefined();
      expect(d.provider).toBeUndefined();
      expect(d.reasoningEffort).toBeUndefined();
      expect(d.threadId).toBeUndefined();
      expect(d.toolCommand).toBeUndefined();
      expect(d.retryTarget).toBeUndefined();
      expect(d.fanInTarget).toBeUndefined();
      expect(d.joinPolicy).toBeUndefined();
      expect(d.fanInRank).toBeUndefined();
      expect(d.maxRetries).toBeUndefined();
    }
  });

  it("conditional nodes expose only state + maxRetries — no model/provider/effort/thread/cmd", () => {
    const src = `digraph g {
      graph [${CASCADE}]
      start [shape=Mdiamond]
      pick [shape=diamond, max_retries=3]
      done [shape=Msquare]
      start -> pick -> done
    }`;
    const d = dataOf(src, "pick");
    expect(d.maxRetries).toBe(3);
    expect(d.model).toBeUndefined();
    expect(d.provider).toBeUndefined();
    expect(d.reasoningEffort).toBeUndefined();
    expect(d.threadId).toBeUndefined();
    expect(d.toolCommand).toBeUndefined();
    expect(d.retryTarget).toBeUndefined();
    expect(d.fanInTarget).toBeUndefined();
    expect(d.joinPolicy).toBeUndefined();
    expect(d.fanInRank).toBeUndefined();
  });

  it("wait.human nodes expose no LLM or tool metadata", () => {
    const src = `digraph g {
      graph [${CASCADE}]
      start [shape=Mdiamond]
      gate [shape=hexagon]
      done [shape=Msquare]
      start -> gate -> done
    }`;
    const d = dataOf(src, "gate");
    expect(d.model).toBeUndefined();
    expect(d.provider).toBeUndefined();
    expect(d.reasoningEffort).toBeUndefined();
    expect(d.threadId).toBeUndefined();
    expect(d.toolCommand).toBeUndefined();
    expect(d.retryTarget).toBeUndefined();
    expect(d.fanInTarget).toBeUndefined();
    expect(d.joinPolicy).toBeUndefined();
    expect(d.fanInRank).toBeUndefined();
  });

  it("parallel nodes expose fanInTarget + joinPolicy but not model/provider/effort/thread", () => {
    const src = `digraph g {
      graph [${CASCADE}]
      start [shape=Mdiamond]
      fork [shape=component, fan_in="join", join_policy="wait_all", max_retries=4]
      a [shape=box]
      b [shape=box]
      join [shape=tripleoctagon]
      done [shape=Msquare]
      start -> fork
      fork -> a -> join
      fork -> b -> join
      join -> done
    }`;
    const d = dataOf(src, "fork");
    expect(d.fanInTarget).toBe("join");
    expect(d.joinPolicy).toBe("wait_all");
    expect(d.model).toBeUndefined();
    expect(d.provider).toBeUndefined();
    expect(d.reasoningEffort).toBeUndefined();
    expect(d.threadId).toBeUndefined();
    expect(d.toolCommand).toBeUndefined();
    expect(d.retryTarget).toBeUndefined();
    expect(d.fanInRank).toBeUndefined();
    // `parallel` is a structural fan-out — the branches retry, not the
    // component itself — so max_retries is intentionally suppressed here.
    expect(d.maxRetries).toBeUndefined();
  });

  it("parallel.fan_in nodes with a prompt expose model/provider/effort; without a prompt they don't", () => {
    const src = `digraph g {
      graph [${CASCADE}]
      start [shape=Mdiamond]
      fork [shape=component]
      a [shape=box]
      b [shape=box]
      rank [shape=tripleoctagon, prompt="rank these", thread_id="shared"]
      heur [shape=tripleoctagon, thread_id="shared"]
      done [shape=Msquare]
      start -> fork
      fork -> a -> rank
      fork -> b -> rank
      rank -> heur -> done
    }`;
    const ranked = dataOf(src, "rank");
    expect(ranked.fanInRank).toBe("prompt");
    expect(ranked.model).toBe("opus");
    expect(ranked.provider).toBe("anthropic");
    expect(ranked.reasoningEffort).toBe("high");
    expect(ranked.threadId).toBe("shared");

    const heuristic = dataOf(src, "heur");
    expect(heuristic.fanInRank).toBe("heuristic");
    expect(heuristic.model).toBeUndefined();
    expect(heuristic.provider).toBeUndefined();
    expect(heuristic.reasoningEffort).toBeUndefined();
    expect(heuristic.threadId).toBeUndefined();
  });

  it("codergen retains the full LLM metadata set", () => {
    const src = `digraph g {
      graph [${CASCADE}]
      start [shape=Mdiamond]
      verify [shape=box, goal_gate=true, retry_target="start", max_retries=3, thread_id="shared"]
      done [shape=Msquare]
      start -> verify -> done
    }`;
    const d = dataOf(src, "verify");
    expect(d.model).toBe("opus");
    expect(d.provider).toBe("anthropic");
    expect(d.reasoningEffort).toBe("high");
    expect(d.threadId).toBe("shared");
    expect(d.retryTarget).toBe("start");
    expect(d.maxRetries).toBe(3);
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

  it("surfaces the model attribute in the node data", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box, llm_model="claude-sonnet-4-5"]
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

describe("toFlowGraph — handler-specific body fields", () => {
  it("surfaces thread_id on codergen nodes (cluster_dev shared session)", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box, thread_id="dev"]
      start -> a
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { threadId?: string }]));
    expect(byId.get("a")?.threadId).toBe("dev");
    expect(byId.get("start")?.threadId).toBeUndefined();
  });

  it("a running tool node propagates state='running' + active=true into FlowNode data", () => {
    // Regression guard for the running-state highlight on parallelogram
    // nodes. Codergen and tool nodes share the fact pipeline
    // (`fact.dispatch_started` → "running" → `fact.node_completed` →
    // "completed"), but only tool nodes were missing a focused test.
    const src = `digraph crowdin {
      start [shape=Mdiamond]
      find_pr [shape=parallelogram, tool_command="gh pr list --head l10n_crowdin --json number"]
      done [shape=Msquare]
      start -> find_pr -> done
    }`;
    const graph = parseDotSource(src);
    const detail = makeDetail({
      nodes: [
        { nodeId: "start", iteration: 0, state: "completed", lastEventSeq: 1 },
        { nodeId: "find_pr", iteration: 0, state: "running", lastEventSeq: 2 },
      ],
      selectedEdges: [{ from: "start", to: "find_pr", iteration: 0 }],
    });
    const { flowNodes } = toFlowGraph(detail, graph, {
      activeNodeIds: new Set(["find_pr"]),
    });
    const findPr = flowNodes.find((n) => n.id === "find_pr")?.data as {
      handler: string;
      state: string;
      active: boolean;
      toolCommand?: string;
    };
    expect(findPr.handler).toBe("tool");
    expect(findPr.state).toBe("running");
    expect(findPr.active).toBe(true);
    // Sanity: tool_command still surfaces while running.
    expect(findPr.toolCommand?.startsWith("gh pr list")).toBe(true);
  });

  it("surfaces tool_command (truncated) only for tool nodes", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      lint [shape=parallelogram, tool_command="bun run lint"]
      verify [shape=parallelogram, tool_command="bun run --filter='@swarm/*' typecheck && bun run lint && bun test"]
      start -> lint -> verify
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { toolCommand?: string; handler: string }]));
    expect(byId.get("lint")?.toolCommand).toBe("bun run lint");
    expect(byId.get("verify")?.toolCommand?.endsWith("…")).toBe(true);
    expect((byId.get("verify")?.toolCommand?.length ?? 0) <= 40).toBe(true);
    expect(byId.get("start")?.toolCommand).toBeUndefined();
  });

  it("surfaces retry_target on goal_gate nodes", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      implement [shape=box]
      review [shape=box, goal_gate=true, retry_target="implement"]
      done [shape=Msquare]
      start -> implement -> review -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const review = flowNodes.find((n) => n.id === "review")?.data as {
      retryTarget?: string;
      goalGate: boolean;
    };
    expect(review.goalGate).toBe(true);
    expect(review.retryTarget).toBe("implement");
  });

  it("surfaces fan_in target + join_policy on parallel nodes", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      explore [shape=component, fan_in=pick_best, join_policy="wait_all"]
      a [shape=box]
      b [shape=box]
      pick_best [shape=tripleoctagon]
      done [shape=Msquare]
      start -> explore
      explore -> a
      explore -> b
      a -> pick_best
      b -> pick_best
      pick_best -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const explore = flowNodes.find((n) => n.id === "explore")?.data as {
      fanInTarget?: string;
      joinPolicy?: string;
    };
    expect(explore.fanInTarget).toBe("pick_best");
    expect(explore.joinPolicy).toBe("wait_all");
  });

  it("classifies parallel.fan_in as prompt-rank vs heuristic", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      explore [shape=component, fan_in=heur, join_policy="wait_all"]
      a [shape=box]
      b [shape=box]
      heur [shape=tripleoctagon]
      llm [shape=tripleoctagon, prompt="rank these by severity"]
      done [shape=Msquare]
      start -> explore
      explore -> a
      explore -> b
      a -> heur
      b -> heur
      heur -> llm
      llm -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { fanInRank?: string }]));
    expect(byId.get("heur")?.fanInRank).toBe("heuristic");
    expect(byId.get("llm")?.fanInRank).toBe("prompt");
  });

  it("flags loop_restart edges with a · loop_restart label suffix and routes through loop handles", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box]
      b [shape=box]
      done [shape=Msquare]
      start -> a -> b -> done
      b -> a [loop_restart=true, label="reset"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const restart = flowEdges.find((e) => e.source === "b" && e.target === "a");
    expect(restart).toBeDefined();
    const data = restart?.data as { loopRestart?: boolean; label?: string; isBackEdge?: boolean };
    expect(data.loopRestart).toBe(true);
    // Label preserves the user's `label="reset"` and appends the attribute name.
    expect(data.label).toContain("reset");
    expect(data.label).toContain("loop_restart");
    expect(data.isBackEdge).toBe(true);
    expect(restart?.sourceHandle).toBe("loop-source");
  });

  it("surfaces max_retries on the node data when set", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      verify [shape=box, max_retries=3]
      done [shape=Msquare]
      start -> verify -> done
    }`;
    const graph = parseDotSource(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const verify = flowNodes.find((n) => n.id === "verify")?.data as { maxRetries?: number };
    expect(verify.maxRetries).toBe(3);
    const start = flowNodes.find((n) => n.id === "start")?.data as { maxRetries?: number };
    expect(start.maxRetries).toBeUndefined();
  });

  it("appends `· cap N` to back-edge labels when the target has max_retries", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      plan [shape=box, max_retries=2]
      review [shape=box]
      done [shape=Msquare]
      start -> plan -> review -> done
      review -> plan [condition="outcome=fail", label="rejected"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const back = flowEdges.find((e) => e.source === "review" && e.target === "plan");
    expect(back).toBeDefined();
    const data = back?.data as { label?: string; isBackEdge?: boolean };
    expect(data.isBackEdge).toBe(true);
    // Condition `outcome=fail` renders as just `fail` (CSS uppercases),
    // with the cap appended.
    expect(data.label).toContain("fail");
    expect(data.label).not.toContain("outcome=");
    expect(data.label).toContain("· cap 2");
  });

  it("appends `· cap N` to self-loop edges (the simplest retry idiom)", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      verify [shape=box, max_retries=3]
      done [shape=Msquare]
      start -> verify -> done
      verify -> verify [condition="outcome=fail"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const self = flowEdges.find((e) => e.source === "verify" && e.target === "verify");
    expect(self).toBeDefined();
    const data = self?.data as { label?: string; isBackEdge?: boolean };
    expect(data.isBackEdge).toBe(true); // routed as a loop
    expect(data.label).toContain("fail");
    expect(data.label).not.toContain("outcome=");
    expect(data.label).toContain("· cap 3");
    // Self-loops also route through the loop handles.
    expect(self?.sourceHandle).toBe("loop-source");
  });

  it("synthesises a retarget edge per goal_gate node with a §3.4 chain", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      implement [shape=box]
      review [shape=box, goal_gate=true, retry_target="implement"]
      done [shape=Msquare]
      start -> implement -> review -> done
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const synth = flowEdges.find(
      (e) => e.source === "review" && e.target === "implement" && e.id.startsWith("__retarget__"),
    );
    expect(synth).toBeDefined();
    const data = synth?.data as { label?: string; isRetargetEdge?: boolean; isBackEdge?: boolean };
    expect(data.isRetargetEdge).toBe(true);
    expect(data.isBackEdge).toBe(true);
    expect(data.label?.startsWith("retarget")).toBe(true);
    // Default cap is 3 when graph doesn't override.
    expect(data.label).toContain("cap 3");
    expect(data.label).toContain("default");
    // Synthetic retargets route through the LEFT-side handles so they
    // visually separate from real back-edges (right-side).
    expect(synth?.sourceHandle).toBe("retarget-source");
    expect(synth?.targetHandle).toBe("retarget-target");
  });

  it("falls back to graph-level retry_target when the gate has none", () => {
    const src = `digraph g {
      graph [retry_target="plan", max_goal_gate_retries=2]
      start [shape=Mdiamond]
      plan [shape=box]
      review [shape=box, goal_gate=true]
      done [shape=Msquare]
      start -> plan -> review -> done
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const synth = flowEdges.find((e) => e.id.startsWith("__retarget__") && e.source === "review");
    expect(synth?.target).toBe("plan");
    const data = synth?.data as { label?: string };
    // Custom cap surfaces (no "(default)" tag).
    expect(data.label).toContain("cap 2");
    expect(data.label).not.toContain("default");
  });

  it("emits no synthetic edge when no retarget resolves anywhere in the chain", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      review [shape=box, goal_gate=true]
      done [shape=Msquare]
      start -> review -> done
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const synth = flowEdges.find((e) => e.id.startsWith("__retarget__"));
    expect(synth).toBeUndefined();
  });

  it("assigns arcIndex by source depth — topmost source gets the widest bulge", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box]
      b [shape=box]
      c [shape=box, goal_gate=true, retry_target="a"]
      d [shape=box, goal_gate=true, retry_target="a"]
      done [shape=Msquare]
      start -> a -> b -> c -> d -> done
      // Two right-side back-edges to a. d is deeper than c, so d's
      // back-edge gets arcIndex 0 (tightest) and c's gets arcIndex 1.
      c -> a [condition="outcome=fail"]
      d -> a [condition="outcome=fail"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const realArcs = new Map<string, number | undefined>();
    for (const e of flowEdges) {
      if (e.id.startsWith("__retarget__")) continue;
      if (!(e.data as { isBackEdge?: boolean })?.isBackEdge) continue;
      realArcs.set(`${e.source}->${e.target}`, (e.data as { arcIndex?: number }).arcIndex);
    }
    // Bottommost (d) → 0, topmost (c) → 1. Assignment is per-side dense.
    expect(realArcs.get("d->a")).toBe(0);
    expect(realArcs.get("c->a")).toBe(1);

    // Same rule on the left side: synthetic retargets sort by gate depth
    // descending, so d's retarget gets arcIndex 0 and c's gets arcIndex 1.
    const synth = new Map<string, number | undefined>();
    for (const e of flowEdges) {
      if (!e.id.startsWith("__retarget__")) continue;
      synth.set(e.source, (e.data as { arcIndex?: number }).arcIndex);
    }
    expect(synth.get("d")).toBe(0);
    expect(synth.get("c")).toBe(1);
  });

  it("skip-edges share the right-side arcIndex with loop-channel edges (no overlap)", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box]
      b [shape=box]
      c [shape=box]
      d [shape=box]
      done [shape=Msquare]
      // Linear spine + a back-edge + a skip-edge that bulges right.
      start -> a -> b -> c -> d -> done
      d -> a [condition="outcome=fail"]
      a -> done [condition="outcome=fail"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    // Both kinds participate in the right-side counter. Source order in
    // the .dot determines assignment, so the skip-edge a->done (declared
    // last) should get a higher index than the back-edge d->a.
    const back = flowEdges.find((e) => e.source === "d" && e.target === "a");
    const skip = flowEdges.find((e) => e.source === "a" && e.target === "done");
    const backIndex = (back?.data as { arcIndex?: number })?.arcIndex;
    const skipIndex = (skip?.data as { arcIndex?: number })?.arcIndex;
    expect(typeof backIndex).toBe("number");
    expect(typeof skipIndex).toBe("number");
    expect(skipIndex).not.toBe(backIndex);
  });

  it("flags HITL edges (from a wait.human source) so they render in idle-gray", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      review [shape=hexagon, prompt="Approve or reject?"]
      ship [shape=box]
      stop [shape=Msquare]
      start -> review
      review -> ship [label="[A] Approve"]
      review -> stop [label="[R] Reject"]
    }`;
    const graph = parseDotSource(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const approve = flowEdges.find((e) => e.source === "review" && e.target === "ship");
    const reject = flowEdges.find((e) => e.source === "review" && e.target === "stop");
    expect((approve?.data as { isHitlEdge?: boolean })?.isHitlEdge).toBe(true);
    expect((reject?.data as { isHitlEdge?: boolean })?.isHitlEdge).toBe(true);
    // Plain forward edges (start -> review) shouldn't be flagged.
    const intoReview = flowEdges.find((e) => e.source === "start" && e.target === "review");
    expect((intoReview?.data as { isHitlEdge?: boolean })?.isHitlEdge).toBe(false);
  });
});

describe("toFlowGraph — edge traversal counts (looped edges)", () => {
  // The bug: edges that fire repeatedly (back-edges, self-loops, goal-gate
  // retargets, max_retries loops) render identically to one-shot edges,
  // and there's no signal of how many times each fired. The signal lives
  // in `detail.selectedEdges` — an ordered (from, to, iteration) log —
  // which `toFlowGraph` must aggregate by (from, to) and stamp on each
  // FlowEdge.data so the renderer can highlight + badge them.
  it("stamps a traversalCount on each edge derived from detail.selectedEdges", () => {
    // `audit -> review -> audit` cycle: review REJECTs twice, then approves.
    // The back-edge `review -> audit` therefore fires twice; the forward
    // edge `audit -> review` fires three times (once per audit visit);
    // `review -> done` fires once.
    const src = `digraph loop {
      audit [shape=box]
      review [shape=diamond]
      done [shape=Msquare]
      audit -> review
      review -> audit [condition="outcome=fail"]
      review -> done [condition="outcome=success"]
    }`;
    const graph = parseDotSource(src);
    const detail = makeDetail({
      nodes: [
        { nodeId: "audit", iteration: 2, state: "completed", lastEventSeq: 9 },
        { nodeId: "review", iteration: 2, state: "completed", lastEventSeq: 10 },
      ],
      selectedEdges: [
        { from: "audit", to: "review", iteration: 0 },
        { from: "review", to: "audit", iteration: 0 },
        { from: "audit", to: "review", iteration: 1 },
        { from: "review", to: "audit", iteration: 1 },
        { from: "audit", to: "review", iteration: 2 },
        { from: "review", to: "done", iteration: 0 },
      ],
      workflowSource: src,
    });
    const { flowEdges } = toFlowGraph(detail, graph);
    const byPair = new Map(
      flowEdges.map((e) => [`${e.source}->${e.target}`, e.data as { traversalCount?: number; isBackEdge?: boolean }]),
    );
    expect(byPair.get("audit->review")?.traversalCount).toBe(3);
    // The looped back-edge — the centerpiece of the bug — must carry the
    // count of every traversal (2), not just a boolean "taken" flag.
    expect(byPair.get("review->audit")?.traversalCount).toBe(2);
    expect(byPair.get("review->audit")?.isBackEdge).toBe(true);
    expect(byPair.get("review->done")?.traversalCount).toBe(1);
  });

  // Bug: when the engine retargets through a goal_gate's implicit
  // §3.4 jump (e.g. review -> implement via retry_target="implement"),
  // the synthetic retarget edge stays dimmed even though the retarget
  // actually fired. The earlier signal here used the gate's iteration
  // field — that doesn't work because goal-gate retargets do NOT
  // advance iteration: every visit to the same gate keeps `iteration=0`
  // (verified empirically against `routing.goal_gates.__retries`-style
  // retarget cycles in real runs). The right signal is the gate's
  // outgoing edge selections: each visit produces exactly one
  // `edge.selected` whose `from === gateId`, so N visits ⇒ N − 1
  // retarget firings.
  it("highlights the synthetic goal-gate back-edge after a retarget fires", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      implement [shape=box]
      review [shape=box, goal_gate=true, retry_target="implement"]
      done [shape=Msquare]
      start -> implement -> review -> done
    }`;
    const graph = parseDotSource(src);
    // Simulate one retarget cycle: implement → review fires twice,
    // review → done fires twice (the goal-gate enforcement at `done`
    // observes `review` unsatisfied on the first hit and retargets back
    // to `implement`; the second hit goes through cleanly). Iteration
    // stays at 0 across the retarget — that's the runtime invariant
    // this test pins.
    const detail = makeDetail({
      nodes: [
        { nodeId: "start", iteration: 0, state: "completed", lastEventSeq: 1 },
        { nodeId: "implement", iteration: 0, state: "completed", lastEventSeq: 4 },
        { nodeId: "review", iteration: 0, state: "completed", lastEventSeq: 5 },
        { nodeId: "done", iteration: 0, state: "completed", lastEventSeq: 6 },
      ],
      selectedEdges: [
        { from: "start", to: "implement", iteration: 0 },
        { from: "implement", to: "review", iteration: 0 },
        { from: "review", to: "done", iteration: 0 }, // first visit → fail-then-retarget
        { from: "implement", to: "review", iteration: 0 }, // cycle 2
        { from: "review", to: "done", iteration: 0 }, // second visit → APPROVE
      ],
      workflowSource: src,
      status: "success",
    });
    const { flowEdges } = toFlowGraph(detail, graph);
    const synth = flowEdges.find(
      (e) => e.id.startsWith("__retarget__") && e.source === "review" && e.target === "implement",
    );
    expect(synth).toBeDefined();
    const data = synth?.data as { dim?: boolean; traversalCount?: number };
    // The bug: this used to render dimmed because the prior logic asked
    // `maxIterationByNode.get('review')` which is always 0 for goal-gate
    // retargets. With the gate-outgoing-count signal it now flips to
    // `dim:false` once the gate visited more than once.
    expect(data.dim).toBe(false);
    // ×1 badge surfaces because review was visited twice (one retarget
    // fired between the visits).
    expect(data.traversalCount).toBe(1);
  });

  // Linear-edge ×N regression guard. Pre-fix, the snapshot+overlay merge
  // in `useDetailOverlay.mergeDetail` appended overlay edges without
  // dropping the ones the snapshot already covered, so every linear edge
  // showed `· ×2` (or more). Pin that one-shot edges carry no count.
  it("one-shot linear edges carry no traversalCount badge", () => {
    const src = `digraph g {
      start [shape=Mdiamond]
      a [shape=box]
      b [shape=box]
      done [shape=Msquare]
      start -> a -> b -> done
    }`;
    const graph = parseDotSource(src);
    const detail = makeDetail({
      nodes: [
        { nodeId: "start", iteration: 0, state: "completed", lastEventSeq: 1 },
        { nodeId: "a", iteration: 0, state: "completed", lastEventSeq: 2 },
        { nodeId: "b", iteration: 0, state: "completed", lastEventSeq: 3 },
        { nodeId: "done", iteration: 0, state: "completed", lastEventSeq: 4 },
      ],
      selectedEdges: [
        { from: "start", to: "a", iteration: 0 },
        { from: "a", to: "b", iteration: 0 },
        { from: "b", to: "done", iteration: 0 },
      ],
      workflowSource: src,
      status: "success",
    });
    const { flowEdges } = toFlowGraph(detail, graph);
    const byPair = new Map(
      flowEdges
        .filter((e) => !e.id.startsWith("__retarget__"))
        .map((e) => [`${e.source}->${e.target}`, e.data as { traversalCount?: number }]),
    );
    expect(byPair.get("start->a")?.traversalCount).toBe(1);
    expect(byPair.get("a->b")?.traversalCount).toBe(1);
    expect(byPair.get("b->done")?.traversalCount).toBe(1);
  });
});
