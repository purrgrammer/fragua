import { describe, expect, test } from "bun:test";
import { deriveBranchMeta } from "../../src/lib/branch-meta.ts";

describe("deriveBranchMeta", () => {
  test("derives active branch state from merged descendant events", () => {
    const meta = deriveBranchMeta(
      [
        {
          type: "fact.node_started",
          payload: { nodeId: "lens_a", parentNodeId: "fanout", parallelIndex: 0 },
        },
        {
          type: "fact.node_completed",
          payload: { nodeId: "lens_b", parentNodeId: "fanout", parallelIndex: 1, outcomeStatus: "success" },
        },
      ],
      [],
    );

    expect(meta.parentToBranches.get("fanout")).toEqual(["lens_a", "lens_b"]);
    expect(meta.activeBranchesByParent.get("fanout")).toEqual(["lens_a"]);
  });
});
