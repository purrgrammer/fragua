// GraphView tests — the AI-Elements / @xyflow/react path.
//
// What we assert:
//
//   - `toFlowGraph()` (the pure transform) produces one FlowEdge per
//     edge declared in the parsed workflow, including edges that touch
//     start/exit terminals — terminals stay visible because labelled
//     exit edges carry meaning.
//   - Rendered output carries a `data-node-id` attribute per graph node
//     (happy-dom CAN mount the custom Node component) so Playwright /
//     unit tests targeting specific nodes keep working.
//   - Lifecycle state flows through to `data-state` on each node.
//   - Back-edges (target at an earlier layout depth than source) are
//     marked `isBackEdge` so the edge renderer picks the Loop variant.
//   - Edge `label` / `outcome` / `route` attrs surface as edge.data.label
//     so operators can tell branching edges apart without opening the
//     inspector.
//   - With no workflowSource the component renders the purpose-built
//     empty state rather than crashing.
//   - `onNodeClick` fires with the clicked node id.
//
// Why we don't assert on `.react-flow__edge` DOM nodes: happy-dom can't
// compute layout (no getBoundingClientRect values), and React-Flow
// short-circuits edge rendering when source/target rects are zero. The
// `toFlowGraph` unit tests cover the data path; visual regressions get
// caught by the running dev server + Playwright (future).

import { afterEach, describe, expect, it } from "bun:test";
import { parseWorkflow } from "@swarm/core";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { GraphView, toFlowGraph } from "../../src/components/GraphView.tsx";
import type { RunDetail } from "../../src/lib/api.ts";
import { renderWithClient as render } from "../helpers/with-query-client.tsx";
import { useDom } from "../setup.ts";

// start → middle → exit (middle is the only declared step; the parser
// synthesises the `start` entry node and the `exit` sink).
const WORKFLOW_SOURCE = `name: demo
description: demo
steps:
  middle:
    type: llm
    label: middle
`;

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
  it("emits one FlowEdge per parsed edge, anchored to correct source/target", () => {
    const graph = parseWorkflow(WORKFLOW_SOURCE);
    const { flowEdges, flowNodes } = toFlowGraph(makeDetail(), graph);

    // One FlowEdge per graph edge.
    expect(flowEdges.length).toBe(graph.edges.length);
    expect(flowEdges.some((e) => e.source === "start" && e.target === "middle")).toBe(true);
    expect(flowEdges.some((e) => e.source === "middle" && e.target === "exit")).toBe(true);

    // Every edge endpoint has a corresponding node in flowNodes.
    const nodeIds = new Set(flowNodes.map((n) => n.id));
    for (const e of flowEdges) {
      expect(nodeIds.has(e.source)).toBe(true);
      expect(nodeIds.has(e.target)).toBe(true);
    }
  });

  it("unions graph.nodes with detail.nodes so topology-only nodes render as pending", () => {
    const graph = parseWorkflow(WORKFLOW_SOURCE);
    const { flowNodes } = toFlowGraph(makeDetail(), graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { state: string; label?: string }]));
    // `exit` is only in topology (no lifecycle event yet).
    expect(byId.get("exit")?.state).toBe("pending");
    expect(byId.get("start")?.state).toBe("completed");
    expect(byId.get("middle")?.state).toBe("running");
    // Label comes from the step's `label` attr.
    expect(byId.get("middle")?.label).toBe("middle");
  });

  it("marks the activeNodeId entry as active", () => {
    const graph = parseWorkflow(WORKFLOW_SOURCE);
    const { flowNodes } = toFlowGraph(makeDetail(), graph, { activeNodeId: "middle" });
    const active = flowNodes.find((n) => n.id === "middle")?.data as { active: boolean };
    expect(active.active).toBe(true);
    const other = flowNodes.find((n) => n.id === "start")?.data as { active: boolean };
    expect(other.active).toBe(false);
  });

  it("every edge carries a markerEnd so direction is unambiguous", () => {
    const graph = parseWorkflow(WORKFLOW_SOURCE);
    const { flowEdges } = toFlowGraph(null, graph);
    for (const e of flowEdges) {
      expect(e.markerEnd).toBeDefined();
    }
  });
});

describe("toFlowGraph — back-edge detection + edge labels", () => {
  it("marks back-edges whose target sits at an earlier depth as isBackEdge", () => {
    const src = `name: g
steps:
  a:
    type: llm
  b:
    type: llm
  c:
    type: llm
    on: {success: exit, fail: a}
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const byPair = new Map(flowEdges.map((e) => [`${e.source}->${e.target}`, e.data as { isBackEdge?: boolean }]));
    expect(byPair.get("a->b")?.isBackEdge).toBe(false);
    expect(byPair.get("b->c")?.isBackEdge).toBe(false);
    expect(byPair.get("c->a")?.isBackEdge).toBe(true);
  });

  it("self-loop edges route through the side handles so they arc outside the column", () => {
    const src = `name: g
steps:
  verify:
    type: llm
    on: {success: exit, fail: verify}
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const self = flowEdges.find((e) => e.source === "verify" && e.target === "verify");
    expect(self?.sourceHandle).toBe("loop-source");
    expect(self?.targetHandle).toBe("loop-target");
    const forward = flowEdges.find((e) => e.source === "start" && e.target === "verify");
    expect(forward?.sourceHandle).toBeUndefined();
    expect(forward?.targetHandle).toBeUndefined();
  });

  it("attaches arcExtent to a skip-edge based on the intermediate layer's extent", () => {
    // start_n fans out to a/b/c (depth 2, spread laterally) and also jumps
    // straight to done_n (depth 3). The start_n -> done_n edge is a
    // skip-edge that has to clear the fanned-out layer-2 column, so its
    // arcExtent reads that layer's lateral extent.
    const src = `name: fan
steps:
  start_n:
    type: llm
    routes: {to_a: a, to_b: b, to_c: c, to_done: done_n}
  a:
    type: llm
    next: done_n
  b:
    type: llm
    next: done_n
  c:
    type: llm
    next: done_n
  done_n:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const skip = flowEdges.find((e) => e.source === "start_n" && e.target === "done_n");
    expect(skip).toBeTruthy();
    const data = skip?.data as { isSkipEdge?: boolean; arcExtent?: number };
    expect(data?.isSkipEdge).toBe(true);
    expect(typeof data?.arcExtent).toBe("number");
    expect(data?.arcExtent ?? 0).toBeGreaterThan(0);

    // The direct edge to the adjacent layer doesn't clear an intermediate
    // node, so it carries no arcExtent.
    const direct = flowEdges.find((e) => e.source === "start_n" && e.target === "a");
    expect(direct).toBeTruthy();
    const directData = direct?.data as { arcExtent?: number };
    expect(directData?.arcExtent).toBeUndefined();
  });

  it("derives label from attrs.label > attrs.outcome > attrs.route", () => {
    const src = `name: g
steps:
  a:
    type: llm
    routes:
      lbl: {to: b, label: custom label}
      small_change: c
  b:
    type: llm
  c:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const byPair = new Map(
      flowEdges.map((e) => [`${e.source}->${e.target}`, e.data as { label?: string; outcome?: string }]),
    );
    // attrs.label is used verbatim.
    expect(byPair.get("a->b")?.label).toBe("custom label");
    // attrs.route humanized when no label.
    expect(byPair.get("a->c")?.label).toBe("Small Change");
  });
});

describe("GraphView — rendering", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders a data-node-id per node", async () => {
    const { container } = render(<GraphView detail={makeDetail()} />);
    const canvas = await waitFor(() => within(container).getByTestId("graphview"));
    const nodeAnchors = canvas.querySelectorAll("[data-node-id]");
    const ids = new Set(Array.from(nodeAnchors).map((el) => el.getAttribute("data-node-id")));
    expect(ids.has("start")).toBe(true);
    expect(ids.has("middle")).toBe(true);
    expect(ids.has("exit")).toBe(true);
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
    expect(byId.get("exit")).toBe("pending");
  });

  it("a running tool node renders with the active ring + thinking-pulse dot + teal handler strip", async () => {
    const src = `name: crowdin
steps:
  find_pr:
    type: tool
    run: gh pr list --head l10n_crowdin
`;
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
    const exit = canvas.querySelector('[data-node-id="exit"]') as HTMLElement | null;
    const middle = canvas.querySelector('[data-node-id="middle"]') as HTMLElement | null;
    expect(start).toBeTruthy();
    expect(exit).toBeTruthy();
    expect(middle).toBeTruthy();

    // Compact marker on lifecycle terminals only.
    expect(start?.getAttribute("data-compact")).toBe("true");
    expect(exit?.getAttribute("data-compact")).toBe("true");
    expect(middle?.getAttribute("data-compact")).toBeNull();

    // Terminals drop the metadata body — no `id` / `model` / `effort` rows.
    const wStart = within(start as HTMLElement);
    const wExit = within(exit as HTMLElement);
    expect(wStart.queryByText("id")).toBeNull();
    expect(wStart.queryByText("model")).toBeNull();
    expect(wStart.queryByText("effort")).toBeNull();
    expect(wExit.queryByText("id")).toBeNull();

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
    const src = `name: styled
steps:
  middle:
    type: llm
    label: middle
    model: opus
    provider: anthropic
    effort: high
`;
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

describe("toFlowGraph — metadata is gated by handler type", () => {
  type Meta = {
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    threadId?: string;
    toolCommand?: string;
    retryTarget?: string;
    maxRetries?: number;
  };

  function dataOf(src: string, id: string): Meta {
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const node = flowNodes.find((n) => n.id === id);
    if (!node) throw new Error(`no node ${id} in flow graph`);
    return node.data as Meta;
  }

  it("tool nodes expose toolCommand + maxRetries but not model/provider/effort/thread/retryTarget", () => {
    const src = `name: g
steps:
  run:
    type: tool
    run: bun test
    max-retries: 2
    model: opus
    provider: anthropic
    effort: high
    thread: shared
`;
    const d = dataOf(src, "run");
    expect(d.toolCommand).toBe("bun test");
    expect(d.maxRetries).toBe(2);
    expect(d.model).toBeUndefined();
    expect(d.provider).toBeUndefined();
    expect(d.reasoningEffort).toBeUndefined();
    expect(d.threadId).toBeUndefined();
    expect(d.retryTarget).toBeUndefined();
  });

  it("start and exit nodes expose no LLM, tool, retry, or thread metadata", () => {
    const src = `name: g
steps:
  a:
    type: llm
`;
    for (const id of ["start", "exit"]) {
      const d = dataOf(src, id);
      expect(d.model).toBeUndefined();
      expect(d.provider).toBeUndefined();
      expect(d.reasoningEffort).toBeUndefined();
      expect(d.threadId).toBeUndefined();
      expect(d.toolCommand).toBeUndefined();
      expect(d.retryTarget).toBeUndefined();
      expect(d.maxRetries).toBeUndefined();
    }
  });

  it("human nodes expose no LLM or tool metadata", () => {
    const src = `name: g
steps:
  gate:
    type: human
    text: approve?
    routes: {ok: exit}
    model: opus
    thread: shared
`;
    const d = dataOf(src, "gate");
    expect(d.model).toBeUndefined();
    expect(d.provider).toBeUndefined();
    expect(d.reasoningEffort).toBeUndefined();
    expect(d.threadId).toBeUndefined();
    expect(d.toolCommand).toBeUndefined();
    expect(d.retryTarget).toBeUndefined();
  });

  it("llm retains the full LLM metadata set", () => {
    const src = `name: g
steps:
  implement:
    type: llm
  verify:
    type: llm
    thread: shared
    retry: implement
    max-retries: 3
    model: opus
    provider: anthropic
    effort: high
`;
    const d = dataOf(src, "verify");
    expect(d.model).toBe("opus");
    expect(d.provider).toBe("anthropic");
    expect(d.reasoningEffort).toBe("high");
    expect(d.threadId).toBe("shared");
    expect(d.retryTarget).toBe("implement");
    expect(d.maxRetries).toBe(3);
  });
});

describe("toFlowGraph — layout + metadata", () => {
  it("default orientation is top-to-bottom (depth drives y)", () => {
    const src = `name: g
steps:
  a:
    type: llm
  b:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(makeDetail({ workflowSource: src, nodes: [] }), graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.position]));
    const start = byId.get("start");
    const exit = byId.get("exit");
    expect(start).toBeDefined();
    expect(exit).toBeDefined();
    // Top-to-bottom: `exit` sits BELOW `start` (greater y).
    expect((exit?.y ?? 0) > (start?.y ?? 0)).toBe(true);
  });

  it("LR orientation swaps axes (depth drives x)", () => {
    const src = `name: g
steps:
  a:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(makeDetail({ workflowSource: src, nodes: [] }), graph, { orientation: "LR" });
    const byId = new Map(flowNodes.map((n) => [n.id, n.position]));
    const start = byId.get("start");
    const exit = byId.get("exit");
    expect((exit?.x ?? 0) > (start?.x ?? 0)).toBe(true);
  });

  it("surfaces the model attribute in the node data", () => {
    const src = `name: g
steps:
  a:
    type: llm
    model: claude-sonnet-4-5
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const aData = flowNodes.find((n) => n.id === "a")?.data as { model?: string };
    expect(aData.model).toBe("claude-sonnet-4-5");
  });

  it("static mode (null detail) emits nodes with state=null and non-animated edges", () => {
    const src = `name: g
steps:
  a:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowNodes, flowEdges } = toFlowGraph(null, graph);
    expect(flowNodes.every((n) => (n.data as { state: unknown }).state === null)).toBe(true);
    expect(flowEdges.every((e) => (e.data as { animated: boolean }).animated === false)).toBe(true);
  });

  it("selectedNodeId flag flows to the selected node", () => {
    const src = `name: g
steps:
  a:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph, { selectedNodeId: "exit" });
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { selected: boolean }]));
    expect(byId.get("exit")?.selected).toBe(true);
    expect(byId.get("start")?.selected).toBe(false);
  });
});

describe("toFlowGraph — handler-specific body fields", () => {
  it("surfaces thread_id on llm nodes (shared session)", () => {
    const src = `name: g
steps:
  a:
    type: llm
    thread: dev
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { threadId?: string }]));
    expect(byId.get("a")?.threadId).toBe("dev");
    expect(byId.get("start")?.threadId).toBeUndefined();
  });

  it("surfaces tool_command (truncated) only for tool nodes", () => {
    const src = `name: g
steps:
  lint:
    type: tool
    run: bun run lint
    next: verify
  verify:
    type: tool
    run: bun run --filter='@swarm/*' typecheck && bun run lint && bun test
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const byId = new Map(flowNodes.map((n) => [n.id, n.data as { toolCommand?: string; handler: string }]));
    expect(byId.get("lint")?.toolCommand).toBe("bun run lint");
    expect(byId.get("verify")?.toolCommand?.endsWith("…")).toBe(true);
    expect((byId.get("verify")?.toolCommand?.length ?? 0) <= 40).toBe(true);
    expect(byId.get("start")?.toolCommand).toBeUndefined();
  });

  it("surfaces retry_target + goalGate on a `retry:` gate node", () => {
    const src = `name: g
steps:
  implement:
    type: llm
  review:
    type: llm
    retry: implement
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const review = flowNodes.find((n) => n.id === "review")?.data as {
      retryTarget?: string;
      goalGate: boolean;
    };
    expect(review.goalGate).toBe(true);
    expect(review.retryTarget).toBe("implement");
  });

  it("surfaces max_retries on the node data when set", () => {
    const src = `name: g
steps:
  verify:
    type: llm
    max-retries: 3
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const verify = flowNodes.find((n) => n.id === "verify")?.data as { maxRetries?: number };
    expect(verify.maxRetries).toBe(3);
    const start = flowNodes.find((n) => n.id === "start")?.data as { maxRetries?: number };
    expect(start.maxRetries).toBeUndefined();
  });

  it("appends `· cap N` to self-loop edges (the simplest retry idiom)", () => {
    const src = `name: g
steps:
  verify:
    type: llm
    max-retries: 3
    on: {success: exit, fail: verify}
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const self = flowEdges.find((e) => e.source === "verify" && e.target === "verify");
    expect(self).toBeDefined();
    const data = self?.data as { label?: string; isBackEdge?: boolean };
    expect(data.isBackEdge).toBe(true); // routed as a loop
    // attrs.outcome="fail" → label="fail"; cap appended.
    expect(data.label).toContain("fail");
    expect(data.label).toContain("· cap 3");
    // Self-loops also route through the loop handles.
    expect(self?.sourceHandle).toBe("loop-source");
  });

  it("synthesises a retarget edge per goal_gate node with a retry_target", () => {
    const src = `name: g
steps:
  implement:
    type: llm
  review:
    type: llm
    retry: implement
`;
    const graph = parseWorkflow(src);
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
    // Synthetic retargets route through the LEFT-side handles so they
    // visually separate from real back-edges (right-side).
    expect(synth?.sourceHandle).toBe("retarget-source");
    expect(synth?.targetHandle).toBe("retarget-target");
  });

  it("emits no synthetic edge when the gate has no retry_target", () => {
    const src = `name: g
steps:
  review:
    type: llm
    goal_gate: true
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const synth = flowEdges.find((e) => e.id.startsWith("__retarget__"));
    expect(synth).toBeUndefined();
  });

  it("flags edges adjacent to a human node as isHumanEdge", () => {
    const src = `name: g
steps:
  review:
    type: human
    text: approve?
    routes: {approve: ship, reject: exit}
  ship:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    const approve = flowEdges.find((e) => e.source === "review" && e.target === "ship");
    const reject = flowEdges.find((e) => e.source === "review" && e.target === "exit");
    expect((approve?.data as { isHumanEdge?: boolean })?.isHumanEdge).toBe(true);
    expect((reject?.data as { isHumanEdge?: boolean })?.isHumanEdge).toBe(true);
    // start -> review: start is not human, review IS human (target) → flagged.
    const intoReview = flowEdges.find((e) => e.source === "start" && e.target === "review");
    expect((intoReview?.data as { isHumanEdge?: boolean })?.isHumanEdge).toBe(true);
  });

  it("does NOT flag plain llm-only edges as isHumanEdge", () => {
    const src = `name: g
steps:
  plan:
    type: llm
  implement:
    type: llm
`;
    const graph = parseWorkflow(src);
    const { flowEdges } = toFlowGraph(null, graph);
    for (const e of flowEdges) {
      expect((e.data as { isHumanEdge?: boolean })?.isHumanEdge).toBeFalsy();
    }
  });

  it("stamps routeCount on nodes with non-empty attrs.routes", () => {
    const src = `name: g
steps:
  router:
    type: llm
    routes: {small: exit, large: exit, refactor: exit}
`;
    const graph = parseWorkflow(src);
    const { flowNodes } = toFlowGraph(null, graph);
    const router = flowNodes.find((n) => n.id === "router");
    const plain = flowNodes.find((n) => n.id === "start");
    expect((router?.data as { routeCount?: number }).routeCount).toBe(3);
    expect((plain?.data as { routeCount?: number }).routeCount).toBeUndefined();
  });
});

describe("toFlowGraph — edge traversal counts (looped edges)", () => {
  it("stamps a traversalCount on each edge derived from detail.selectedEdges", () => {
    // `audit -> review -> audit` cycle: review fails twice (back to audit),
    // then succeeds. The back-edge `review -> audit` fires twice; the
    // forward edge `audit -> review` fires three times; `review -> exit`
    // fires once.
    const src = `name: loop
steps:
  audit:
    type: llm
  review:
    type: llm
    on: {success: exit, fail: audit}
`;
    const graph = parseWorkflow(src);
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
        { from: "review", to: "exit", iteration: 0 },
      ],
      workflowSource: src,
    });
    const { flowEdges } = toFlowGraph(detail, graph);
    const byPair = new Map(
      flowEdges.map((e) => [`${e.source}->${e.target}`, e.data as { traversalCount?: number; isBackEdge?: boolean }]),
    );
    expect(byPair.get("audit->review")?.traversalCount).toBe(3);
    expect(byPair.get("review->audit")?.traversalCount).toBe(2);
    expect(byPair.get("review->audit")?.isBackEdge).toBe(true);
    expect(byPair.get("review->exit")?.traversalCount).toBe(1);
  });

  it("one-shot linear edges carry no ×N traversalCount badge", () => {
    const src = `name: g
steps:
  a:
    type: llm
  b:
    type: llm
`;
    const graph = parseWorkflow(src);
    const detail = makeDetail({
      nodes: [
        { nodeId: "start", iteration: 0, state: "completed", lastEventSeq: 1 },
        { nodeId: "a", iteration: 0, state: "completed", lastEventSeq: 2 },
        { nodeId: "b", iteration: 0, state: "completed", lastEventSeq: 3 },
        { nodeId: "exit", iteration: 0, state: "completed", lastEventSeq: 4 },
      ],
      selectedEdges: [
        { from: "start", to: "a", iteration: 0 },
        { from: "a", to: "b", iteration: 0 },
        { from: "b", to: "exit", iteration: 0 },
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
    expect(byPair.get("b->exit")?.traversalCount).toBe(1);
  });

  it("suppresses outcome accent on untaken fail edges during a run", () => {
    // audit has a success path (to review) and a fail skip-edge (to exit).
    // On a clean run only the success edge fires; the fail edge must NOT
    // broadcast red.
    const src = `name: g
steps:
  audit:
    type: llm
    on: {success: review, fail: exit}
  review:
    type: llm
`;
    const graph = parseWorkflow(src);

    const runDetail = makeDetail({
      nodes: [
        { nodeId: "start", iteration: 0, state: "completed", lastEventSeq: 1 },
        { nodeId: "audit", iteration: 0, state: "completed", lastEventSeq: 2 },
        { nodeId: "review", iteration: 0, state: "completed", lastEventSeq: 3 },
        { nodeId: "exit", iteration: 0, state: "completed", lastEventSeq: 4 },
      ],
      selectedEdges: [
        { from: "start", to: "audit", iteration: 0 },
        { from: "audit", to: "review", iteration: 0 }, // success branch
        { from: "review", to: "exit", iteration: 0 },
      ],
      workflowSource: src,
      status: "success",
    });
    const runEdges = toFlowGraph(runDetail, graph).flowEdges;
    const failRun = runEdges.find((e) => e.source === "audit" && e.target === "exit");
    expect(failRun).toBeDefined();
    expect((failRun?.data as { dim?: boolean }).dim).toBe(true);
    // Untaken fail edges drop the outcome accent in run view.
    expect((failRun?.data as { outcome?: string }).outcome).toBeUndefined();

    // Success is the implicit default flow — it never carries an outcome
    // accent. A taken success edge highlights via `animated`, not green.
    const successRun = runEdges.find((e) => e.source === "audit" && e.target === "review");
    expect((successRun?.data as { outcome?: string }).outcome).toBeUndefined();
    expect((successRun?.data as { animated?: boolean }).animated).toBe(true);

    // Workflow-detail view (no run) preserves the declared outcome.
    const detailEdges = toFlowGraph(null, graph).flowEdges;
    const failDetail = detailEdges.find((e) => e.source === "audit" && e.target === "exit");
    expect((failDetail?.data as { outcome?: string }).outcome).toBe("fail");
  });

  it("arcs the non-primary edge of a same-target group so it doesn't overlap the primary", () => {
    // `success` and `fail` both land on `exit`. The success edge (declared
    // first) stays straight; the fail edge arcs out via the side handles so
    // it isn't hidden under the success edge.
    const src = `name: g
steps:
  review:
    type: tool
    run: make
    on: {success: exit, fail: exit}
`;
    const graph = parseWorkflow(src);
    const edges = toFlowGraph(null, graph).flowEdges.filter((e) => e.source === "review" && e.target === "exit");
    expect(edges.length).toBe(2);

    const success = edges.find((e) => (e.data as { outcome?: string }).outcome === undefined);
    const fail = edges.find((e) => (e.data as { outcome?: string }).outcome === "fail");

    // Primary (success) stays straight: no arc, default handles.
    expect((success?.data as { isParallelArc?: boolean }).isParallelArc).toBeFalsy();
    expect(success?.sourceHandle).toBeUndefined();

    // Non-primary (fail) arcs out through the side handles.
    expect((fail?.data as { isParallelArc?: boolean }).isParallelArc).toBe(true);
    expect(fail?.sourceHandle).toBeDefined();
    expect(fail?.targetHandle).toBeDefined();
  });
});
