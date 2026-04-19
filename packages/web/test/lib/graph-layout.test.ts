// Pure unit tests for the DAG layout. Exercises the two orientations +
// cycle-safe depth walk + stable per-layer ordering.

import { describe, expect, it } from "bun:test";
import { layoutDag } from "../../src/lib/graph-layout.ts";

describe("layoutDag", () => {
  it("places a linear chain along the primary axis (TB = y, LR = x)", () => {
    const input = {
      nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };
    const tb = layoutDag(input, { orientation: "TB" });
    const ys = new Map(tb.map((p) => [p.id, p.position.y]));
    expect((ys.get("a") ?? 0) < (ys.get("b") ?? 0)).toBe(true);
    expect((ys.get("b") ?? 0) < (ys.get("c") ?? 0)).toBe(true);

    const lr = layoutDag(input, { orientation: "LR" });
    const xs = new Map(lr.map((p) => [p.id, p.position.x]));
    expect((xs.get("a") ?? 0) < (xs.get("b") ?? 0)).toBe(true);
    expect((xs.get("b") ?? 0) < (xs.get("c") ?? 0)).toBe(true);
  });

  it("defaults to TB when orientation is omitted", () => {
    const input = {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [{ from: "a", to: "b" }],
    };
    const out = layoutDag(input);
    const byId = new Map(out.map((p) => [p.id, p.position]));
    expect((byId.get("b")?.y ?? 0) > (byId.get("a")?.y ?? 0)).toBe(true);
  });

  it("spreads siblings across the perpendicular axis centred on 0", () => {
    const input = {
      nodes: [{ id: "s" }, { id: "a" }, { id: "b" }, { id: "c" }],
      edges: [
        { from: "s", to: "a" },
        { from: "s", to: "b" },
        { from: "s", to: "c" },
      ],
    };
    const tb = layoutDag(input, { orientation: "TB" });
    const siblings = tb.filter((p) => p.id !== "s").map((p) => p.position.x);
    // Three siblings, centred → one negative, one ~0, one positive.
    expect(siblings.some((x) => x < 0)).toBe(true);
    expect(siblings.some((x) => x > 0)).toBe(true);
  });

  it("degrades gracefully on a cycle (no throw, every node positioned)", () => {
    const input = {
      nodes: [{ id: "a" }, { id: "b" }],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    const out = layoutDag(input);
    expect(out.length).toBe(2);
    expect(new Set(out.map((p) => p.id))).toEqual(new Set(["a", "b"]));
  });

  it("picks up ids that appear only in edges (defensive union)", () => {
    const input = { nodes: [{ id: "a" }], edges: [{ from: "a", to: "b" }] };
    const out = layoutDag(input);
    expect(out.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });
});
