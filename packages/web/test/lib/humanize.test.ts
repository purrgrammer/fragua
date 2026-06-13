import { describe, expect, it } from "vitest";
import { humanizeHaltReason, humanizeNodeCompletedSuffix, humanizeRouteName } from "../../src/lib/humanize.ts";

describe("humanizeHaltReason", () => {
  it("labels route_not_picked / route_call_not_isolated / edge_no_match", () => {
    expect(humanizeHaltReason("route_not_picked")).toBe("Route not picked");
    expect(humanizeHaltReason("route_call_not_isolated")).toBe("Route call not isolated");
    expect(humanizeHaltReason("edge_no_match")).toBe("No edge matched");
  });

  it("labels worktree_error", () => {
    expect(humanizeHaltReason("worktree_error")).toBe("Worktree provision failed");
  });

  it("keeps Paused label for paused_human (rename-stable)", () => {
    expect(humanizeHaltReason("paused_human")).toBe("Paused");
  });

  it("falls back to title-cased snake for unknown values", () => {
    expect(humanizeHaltReason("some_new_reason")).toBe("Some New Reason");
  });
});

describe("humanizeRouteName", () => {
  it("title-cases snake_case route identifiers", () => {
    expect(humanizeRouteName("small_change")).toBe("Small Change");
    expect(humanizeRouteName("large")).toBe("Large");
    expect(humanizeRouteName("needs_info")).toBe("Needs Info");
  });

  it("passes through already-readable names unchanged", () => {
    expect(humanizeRouteName("approve")).toBe("Approve");
  });
});

describe("humanizeNodeCompletedSuffix", () => {
  it("formats route as ' → <route>' when route is present", () => {
    expect(humanizeNodeCompletedSuffix({ route: "small" })).toBe(" → small");
    expect(humanizeNodeCompletedSuffix({ route: "large_change" })).toBe(" → large_change");
  });

  it("returns empty string when route is absent", () => {
    expect(humanizeNodeCompletedSuffix({})).toBe("");
    expect(humanizeNodeCompletedSuffix({ outcomeStatus: "success" })).toBe("");
  });

  it("returns empty string for empty route string", () => {
    expect(humanizeNodeCompletedSuffix({ route: "" })).toBe("");
  });
});
