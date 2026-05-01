// NodeInspector component tests. The component is pure — it takes a
// parsed `Node` and an optional `NodeState` — so we exercise it outside
// the router.

import { afterEach, describe, expect, it } from "bun:test";
import { parseDotSource } from "@swarm/core";
import { cleanup, render, within } from "@testing-library/react";
import { NodeInspector } from "../../src/components/NodeInspector.tsx";
import { useDom } from "../setup.ts";

const DOT_SOURCE = `digraph demo {
  a [shape=box, label="Planner", llm_model="opus-4", prompt="plan the work"]
  b [shape=hexagon, label="Review", prompt="human approval"]
  c [shape=box, label="Coder", allowed_tools="shell,ast_search", system_prompt="strict"]
  a -> b
  b -> c
}`;

function nodesFromDot(): ReturnType<typeof parseDotSource>["nodes"] {
  return parseDotSource(DOT_SOURCE).nodes;
}

describe("NodeInspector", () => {
  useDom();
  afterEach(() => cleanup());

  it("renders the empty hint when node is null", () => {
    const { container } = render(<NodeInspector node={null} />);
    expect(within(container).getByTestId("node-inspector-empty")).toBeTruthy();
  });

  it("surfaces identity, model, and prompt for a codergen node", () => {
    const nodes = nodesFromDot();
    const a = nodes["a"];
    expect(a).toBeTruthy();
    if (!a) return;
    const { container } = render(<NodeInspector node={a} />);
    const q = within(container);
    const panel = q.getByTestId("node-inspector");
    expect(panel.getAttribute("data-node-id")).toBe("a");
    expect(panel.getAttribute("data-handler")).toBe("codergen");
    expect(panel.textContent ?? "").toContain("opus-4");
    expect(q.getByTestId("node-inspector-prompt").textContent).toBe("plan the work");
  });

  it("renders a wait.human node header without a codergen prompt block", () => {
    const nodes = nodesFromDot();
    const b = nodes["b"];
    expect(b).toBeTruthy();
    if (!b) return;
    const { container } = render(<NodeInspector node={b} />);
    const panel = within(container).getByTestId("node-inspector");
    expect(panel.getAttribute("data-handler")).toBe("wait.human");
  });

  it("lists allowed tools and system prompt override", () => {
    const nodes = nodesFromDot();
    const c = nodes["c"];
    expect(c).toBeTruthy();
    if (!c) return;
    const { container } = render(<NodeInspector node={c} />);
    const q = within(container);
    const text = container.textContent ?? "";
    expect(text).toContain("shell");
    expect(text).toContain("ast_search");
    expect(q.getByTestId("node-inspector-system-prompt").textContent).toBe("strict");
  });

  it("shows live state when a NodeState entry is supplied", () => {
    const nodes = nodesFromDot();
    const a = nodes["a"];
    if (!a) return;
    const { container } = render(
      <NodeInspector node={a} state={{ nodeId: "a", state: "running", lastEventSeq: 42 }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("running");
    expect(text).toContain("42");
  });
});
