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
      <NodeInspector node={a} state={{ nodeId: "a", iteration: 0, state: "running", lastEventSeq: 42 }} />,
    );
    const text = container.textContent ?? "";
    expect(text).toContain("running");
    expect(text).toContain("42");
  });

  it("surfaces thread_id, class (subgraph-derived), and the goal-gate retarget chain", () => {
    const src = `digraph demo {
      subgraph cluster_dev {
        node [thread_id = "dev"]
        implement [shape=box]
        review [
          shape = box
          goal_gate = true
          retry_target = "implement"
          fallback_retry_target = "plan"
          allow_partial = true
          retry_policy = "standard"
        ]
      }
    }`;
    const review = parseDotSource(src).nodes["review"];
    expect(review).toBeTruthy();
    if (!review) return;
    const { container } = render(<NodeInspector node={review} />);
    const text = container.textContent ?? "";
    expect(text).toContain("dev"); // thread_id
    expect(text).toContain("implement"); // retry_target
    expect(text).toContain("plan"); // fallback_retry_target
    expect(text).toContain("standard"); // retry_policy preset
    expect(text).toContain("allow partial"); // label rendered
    expect(text).toContain("goal gate"); // label rendered
    // Subgraph-derived class lands in node.classes.
    expect(review.classes).toContain("dev");
    expect(text).toContain("dev");
  });

  // Per-handler relevance gating — stylesheet cascade can pin
  // `llm_model` / `thread_id` / `max_retries` on nodes that never act
  // on those attrs (terminals, tools, heuristic fan_ins). The drawer
  // must hide the rows that don't apply so operators don't read
  // misleading config.

  it("hides model/provider/reasoning/thread/retry rows for a start terminal", () => {
    // Stylesheet cascade pins LLM + retry attrs on every node, but the
    // start terminal is a lifecycle marker that never calls them.
    const src = `digraph demo {
      node [llm_model="opus-4", llm_provider="anthropic", reasoning_effort="high", thread_id="shared", max_retries=3, retry_target="a"]
      s [shape=Mdiamond, label="start"]
      a [shape=box]
      s -> a
    }`;
    const s = parseDotSource(src).nodes["s"];
    expect(s).toBeTruthy();
    if (!s) return;
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

  it("hides model/provider/reasoning/thread for a tool node but keeps tool_command", () => {
    // Tool handlers don't call an LLM — the cascade-resolved llm_model
    // is dead config. tool_command is the load-bearing attr.
    const src = `digraph demo {
      node [llm_model="opus-4", llm_provider="anthropic", reasoning_effort="high", thread_id="shared"]
      run_tests [shape=parallelogram, tool_command="bun test"]
    }`;
    const t = parseDotSource(src).nodes["run_tests"];
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
