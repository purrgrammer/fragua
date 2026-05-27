// NodeInspector component tests. The component is pure — it takes a
// parsed `Node` and an optional `NodeState` — so we exercise it outside
// the router.

import { type Node as GraphNode, parseWorkflow } from "@fragua/core";
import { cleanup, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NodeInspector } from "../../src/components/NodeInspector.tsx";
import { useDom } from "../setup.ts";

const SOURCE = `name: demo
steps:
  a:
    type: llm
    label: Planner
    model: opus-4
    prompt: plan the work
    next: b
  b:
    type: human
    label: Review
    text: human approval
    routes: {ok: c}
  c:
    type: llm
    label: Coder
    allowed-tools: [shell, ast_search]
`;

function nodes(): ReturnType<typeof parseWorkflow>["nodes"] {
  return parseWorkflow(SOURCE).nodes;
}

describe("NodeInspector", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders the empty hint when node is null", () => {
    const { container } = render(<NodeInspector node={null} />);
    expect(within(container).getByTestId("node-inspector-empty")).toBeTruthy();
  });

  it("surfaces identity, model, and prompt for a llm node", () => {
    const a = nodes()["a"];
    expect(a).toBeTruthy();
    if (!a) return;
    const { container } = render(<NodeInspector node={a} />);
    const q = within(container);
    const panel = q.getByTestId("node-inspector");
    expect(panel.getAttribute("data-node-id")).toBe("a");
    expect(panel.getAttribute("data-handler")).toBe("llm");
    expect(panel.textContent ?? "").toContain("opus-4");
    expect(q.getByTestId("node-inspector-prompt").textContent).toBe("plan the work");
  });

  it("renders a human node header without a llm prompt block", () => {
    const b = nodes()["b"];
    expect(b).toBeTruthy();
    if (!b) return;
    const { container } = render(<NodeInspector node={b} />);
    const panel = within(container).getByTestId("node-inspector");
    expect(panel.getAttribute("data-handler")).toBe("human");
  });

  it("lists allowed tools for a llm node", () => {
    const c = nodes()["c"];
    expect(c).toBeTruthy();
    if (!c) return;
    const { container } = render(<NodeInspector node={c} />);
    const text = container.textContent ?? "";
    expect(text).toContain("shell");
    expect(text).toContain("ast_search");
  });

  it("shows live state when a NodeState entry is supplied", () => {
    const a = nodes()["a"];
    if (!a) return;
    const { container } = render(
      <NodeInspector node={a} state={{ nodeId: "a", iteration: 0, state: "running", lastEventSeq: 42 }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("running");
    expect(text).toContain("42");
  });

  it("surfaces thread, goal-gate, and the retry target", () => {
    const src = `name: demo
steps:
  implement:
    type: llm
    thread: dev
  review:
    type: llm
    thread: dev
    retry: implement
`;
    const review = parseWorkflow(src).nodes["review"];
    expect(review).toBeTruthy();
    if (!review) return;
    const { container } = render(<NodeInspector node={review} />);
    const text = container.textContent ?? "";
    expect(text).toContain("dev"); // thread_id
    expect(text).toContain("implement"); // retry_target
    expect(text).toContain("goal gate"); // label rendered
  });

  // Per-handler relevance gating — a node's `type` decides whether the
  // LLM / retry rows render. Terminals and tools never call an LLM, so
  // even when those attrs are present on the IR node they must be hidden
  // so operators don't read misleading config.

  it("hides model/provider/reasoning/thread/retry rows for a start terminal", () => {
    const s: GraphNode = {
      id: "s",
      type: "start",
      attrs: {
        model: "opus-4",
        provider: "anthropic",
        reasoning_effort: "high",
        thread_id: "shared",
        max_retries: 3,
        retry_target: "a",
      },
    };
    const { container } = render(<NodeInspector node={s} />);
    const text = container.textContent ?? "";
    // Identity + handler still surface.
    expect(text).toContain("identity");
    expect(text).toContain("start");
    // Suppressed rows.
    expect(text).not.toContain("opus-4");
    expect(text).not.toContain("anthropic");
    expect(text).not.toContain("reasoning");
    expect(text).not.toContain("thread");
    expect(text).not.toContain("max retries");
    expect(text).not.toContain("retry target");
  });

  it("renders attrs.routes as chips in a dedicated section", () => {
    const src = `name: demo
steps:
  router:
    type: llm
    routes: {small: exit, large: exit, refactor: exit}
`;
    const router = parseWorkflow(src).nodes["router"];
    expect(router).toBeTruthy();
    if (!router) return;
    const { container } = render(<NodeInspector node={router} />);
    const routesSection = within(container).getByTestId("node-inspector-routes");
    expect(routesSection).toBeTruthy();
    const text = routesSection.textContent ?? "";
    expect(text).toContain("small");
    expect(text).toContain("large");
    expect(text).toContain("refactor");
  });

  it("surfaces attrs.text for a human node", () => {
    const src = `name: demo
steps:
  review:
    type: human
    text: Please approve or reject the change.
    routes: {ok: exit}
`;
    const review = parseWorkflow(src).nodes["review"];
    expect(review).toBeTruthy();
    if (!review) return;
    const { container } = render(<NodeInspector node={review} />);
    const textBlock = within(container).getByTestId("node-inspector-text");
    expect(textBlock.textContent?.trim()).toBe("Please approve or reject the change.");
  });

  it("does not render routes section when attrs.routes is absent", () => {
    const src = `name: demo
steps:
  plan:
    type: llm
    prompt: plan
`;
    const plan = parseWorkflow(src).nodes["plan"];
    if (!plan) return;
    const { container } = render(<NodeInspector node={plan} />);
    const routesSection = container.querySelector("[data-testid='node-inspector-routes']");
    expect(routesSection).toBeNull();
  });

  it("hides model/provider/reasoning/thread for a tool node but keeps tool_command", () => {
    // Tool handlers don't call an LLM — a `model` attr on a tool node
    // is dead config. tool_command (authored as `run:`) is load-bearing.
    const src = `name: demo
steps:
  run_tests:
    type: tool
    run: bun test
    model: opus-4
    provider: anthropic
    effort: high
    thread: shared
`;
    const t = parseWorkflow(src).nodes["run_tests"];
    expect(t).toBeTruthy();
    if (!t) return;
    const { container } = render(<NodeInspector node={t} />);
    const q = within(container);
    const text = container.textContent ?? "";
    // tool_command renders.
    expect(q.getByTestId("node-inspector-tool-command").textContent).toBe("bun test");
    // LLM section gone.
    expect(text).not.toContain("opus-4");
    expect(text).not.toContain("reasoning");
    expect(text).not.toContain("thread");
    expect(text).not.toContain("model & context");
  });
});
