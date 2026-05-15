import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useDom } from "../../test/setup.ts";
import type { ChildStatusDigest } from "../lib/api.ts";
import { RunStatusBadge } from "./RunStatusBadge.tsx";

function digest(overrides: Partial<ChildStatusDigest>): ChildStatusDigest {
  return {
    total: 0,
    running: 0,
    runningChildren: 0,
    paused: 0,
    pausedHitl: 0,
    pausedAuto: 0,
    queued: 0,
    completed: 0,
    cancelled: 0,
    halted: 0,
    quarantined: 0,
    ...overrides,
  };
}

describe("RunStatusBadge — running_children escalation", () => {
  useDom();
  afterEach(() => cleanup());

  test("running_children with no children info → shows 'running'", () => {
    const { container } = render(<RunStatusBadge status="running" runStatus="running_children" />);
    const pill = container.querySelector('[data-testid="status-running"]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toBe("running");
  });

  test("running_children with pausedHitl child → escalates to paused_hitl tint + label", () => {
    const { container } = render(
      <RunStatusBadge
        status="running"
        runStatus="running_children"
        childStatusDigest={digest({ total: 3, pausedHitl: 1, running: 2 })}
      />,
    );
    const pill = container.querySelector('[data-status="paused"]');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-run-status")).toBe("paused_hitl");
    expect(pill?.getAttribute("data-child-attention")).toBe("true");
  });

  test("running_children with paused (budget) child → escalates to paused tint", () => {
    const { container } = render(
      <RunStatusBadge
        status="running"
        runStatus="running_children"
        childStatusDigest={digest({ total: 3, paused: 1, completed: 2 })}
      />,
    );
    const pill = container.querySelector('[data-status="paused"]');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-run-status")).toBe("paused");
  });

  test("running_children with quarantined child → escalates to paused tint", () => {
    const { container } = render(
      <RunStatusBadge
        status="running"
        runStatus="running_children"
        childStatusDigest={digest({ total: 2, quarantined: 1, running: 1 })}
      />,
    );
    expect(container.querySelector('[data-status="paused"]')).not.toBeNull();
  });

  test("running_children with ONLY paused_auto children → stays 'running' (no operator action needed)", () => {
    const { container } = render(
      <RunStatusBadge
        status="running"
        runStatus="running_children"
        childStatusDigest={digest({ total: 2, pausedAuto: 2 })}
      />,
    );
    const pill = container.querySelector('[data-status="running"]');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute("data-child-attention")).toBeNull();
  });

  test("running_children with completed children only → stays 'running'", () => {
    const { container } = render(
      <RunStatusBadge
        status="running"
        runStatus="running_children"
        childStatusDigest={digest({ total: 3, completed: 3 })}
      />,
    );
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
  });

  test("terminal status (success) does NOT escalate even if a child is paused (parent took precedence)", () => {
    const { container } = render(
      <RunStatusBadge
        status="success"
        runStatus="completed"
        childStatusDigest={digest({ total: 1, paused: 1 })}
      />,
    );
    expect(container.querySelector('[data-status="success"]')).not.toBeNull();
  });

  test("mixed: pausedHitl + paused → label prefers pausedHitl (operator's most urgent signal)", () => {
    const { container } = render(
      <RunStatusBadge
        status="running"
        runStatus="running_children"
        childStatusDigest={digest({ total: 2, pausedHitl: 1, paused: 1 })}
      />,
    );
    const pill = container.querySelector('[data-status="paused"]');
    expect(pill?.getAttribute("data-run-status")).toBe("paused_hitl");
  });
});
