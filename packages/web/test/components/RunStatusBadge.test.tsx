// RunStatusBadge — paused-family colour partition.
//
// The badge takes the coarse `RunSummary["status"]` (which collapses
// `paused`, `paused_auto`, `paused_human` to a single "paused" pill).
// Callers thread the raw `RunDetail["runStatus"]` so the badge can
// differentiate the three: paused yellow, paused_auto blue,
// paused_human orange. This test pins the visual partition by checking
// the rendered Tailwind classes — drift in the badge would shift
// colours silently otherwise.

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { RunStatusBadge } from "../../src/components/RunStatusBadge.tsx";
import { useDom } from "../setup.ts";

describe("RunStatusBadge — paused-family palette", () => {
  useDom();
  afterEach(() => cleanup());

  it("paused (operator must act) → sw-accent-pause (yellow/amber)", () => {
    const { getByTestId } = render(<RunStatusBadge status="paused" runStatus="paused" />);
    const el = getByTestId("status-paused");
    expect(el.className).toContain("text-sw-accent-pause");
    expect(el.getAttribute("data-run-status")).toBe("paused");
  });

  it("paused_auto (daemon timer) → sw-accent-pause-auto (blue)", () => {
    const { getByTestId } = render(<RunStatusBadge status="paused" runStatus="paused_auto" />);
    const el = getByTestId("status-paused");
    expect(el.className).toContain("text-sw-accent-pause-auto");
    expect(el.getAttribute("data-run-status")).toBe("paused_auto");
  });

  it("paused_human (workflow asks) → sw-accent-pause-hitl (orange)", () => {
    const { getByTestId } = render(<RunStatusBadge status="paused" runStatus="paused_human" />);
    const el = getByTestId("status-paused");
    expect(el.className).toContain("text-sw-accent-pause-hitl");
    expect(el.getAttribute("data-run-status")).toBe("paused_human");
  });

  it("paused without runStatus falls through to operator-must-act default", () => {
    const { getByTestId } = render(<RunStatusBadge status="paused" />);
    const el = getByTestId("status-paused");
    // Most likely needs-attention state when raw status is unknown:
    // operator-resumable. Better than gray (could be auto-wake) or
    // orange (could be hitl).
    expect(el.className).toContain("text-sw-accent-pause");
  });

  it("non-paused statuses keep their existing tones (regression: queued stays idle gray)", () => {
    const { getByTestId } = render(<RunStatusBadge status="queued" />);
    const el = getByTestId("status-queued");
    expect(el.className).toContain("text-sw-accent-idle");
  });
});
