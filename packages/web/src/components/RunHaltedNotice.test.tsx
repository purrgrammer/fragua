import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { RunHaltedNotice } from "./RunHaltedNotice.tsx";

describe("RunHaltedNotice", () => {
  afterEach(() => cleanup());

  test("renders occ diagnostic context when haltContext is present", () => {
    render(
      <RunHaltedNotice
        haltReason="occ_exhausted"
        haltDetail="8 consecutive OCC conflicts on fact.node_completed for node implement"
        haltContext={{
          count: 8,
          nodeId: "implement",
          iteration: 3,
          lastVersion: 42,
          attemptedFactType: "fact.node_completed",
        }}
      />,
    );
    const context = screen.getByTestId("run-halted-context");
    expect(context).toBeTruthy();
    expect(context.textContent).toContain("implement");
    expect(context.textContent).toContain("8");
    expect(context.textContent).toContain("fact.node_completed");
    expect(context.textContent).toContain("42");
  });

  test("omits the diagnostic block when haltContext is absent", () => {
    render(<RunHaltedNotice haltReason="error" haltDetail="handler threw: boom" />);
    expect(screen.queryByTestId("run-halted-context")).toBeNull();
  });
});
