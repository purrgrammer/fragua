// Tests for the /analytics page's window math + comparison delta sign.
// `resolveWindow("today")` must produce a compare window covering the
// FULL prior day (yesterday 00:00 → today 00:00), not the partial-elapsed
// fraction — the elapsed-fraction variant hid deltas on quiet mornings
// when yesterday's prior fraction had zero activity.
//
// `computeDelta` must produce a tone that respects `direction='inverse'`
// (a drop in spend reads positive, a rise reads negative). The arrow
// glyph is bound to the SIGN of the ratio in ComparisonDelta — those
// assertions live in this file too so a future reorder of tone vs sign
// gets caught immediately.

import { describe, expect, it } from "vitest";
import { resolveWindow } from "../../src/lib/analytics.ts";
import { computeDelta } from "../../src/lib/humanize.ts";

const DAY_MS = 86_400_000;

describe("resolveWindow", () => {
  it("today: comparison spans the FULL prior day, not the elapsed fraction", () => {
    // Pick a deterministic local timestamp: 2026-04-29T10:00:00 local.
    const now = new Date(2026, 3, 29, 10, 0, 0, 0);
    const w = resolveWindow("today", now);

    const todayStart = new Date(2026, 3, 29, 0, 0, 0, 0).getTime();
    const yesterdayStart = todayStart - DAY_MS;

    expect(w.fromMs).toBe(todayStart);
    expect(w.toMs).toBe(now.getTime());
    expect(w.compareFromMs).toBe(yesterdayStart);
    expect(w.compareToMs).toBe(todayStart);
    expect(w.bucket).toBe("hour");
  });

  it("last7: previous-period window has the same span as the current window", () => {
    const now = new Date(2026, 3, 29, 12, 0, 0, 0);
    const w = resolveWindow("last7", now);
    const span = w.toMs - w.fromMs;
    expect(w.compareFromMs).not.toBeNull();
    expect(w.compareToMs).not.toBeNull();
    expect(w.compareToMs! - w.compareFromMs!).toBe(span);
    expect(w.compareToMs).toBe(w.fromMs);
  });

  it("all: no comparison window", () => {
    const now = new Date();
    const w = resolveWindow("all", now);
    expect(w.compareFromMs).toBeNull();
    expect(w.compareToMs).toBeNull();
  });
});

describe("computeDelta", () => {
  it("normal direction: growth reads positive, shrinkage reads negative", () => {
    expect(computeDelta(150, 100, "normal").tone).toBe("positive");
    expect(computeDelta(50, 100, "normal").tone).toBe("negative");
  });

  it("inverse direction: shrinkage reads positive (less spend = good)", () => {
    expect(computeDelta(50, 100, "inverse").tone).toBe("positive");
    expect(computeDelta(150, 100, "inverse").tone).toBe("negative");
  });

  it("ratio sign reflects the metric direction regardless of tone", () => {
    // Spend dropped — tone is positive (good), but ratio is negative (less).
    // The KPI strip binds the ARROW to ratio sign, the COLOUR to tone.
    const dropped = computeDelta(50, 100, "inverse");
    expect(dropped.tone).toBe("positive");
    expect(dropped.ratio).toBeLessThan(0);

    // Spend grew — tone is negative (bad), ratio is positive (more).
    const grew = computeDelta(150, 100, "inverse");
    expect(grew.tone).toBe("negative");
    expect(grew.ratio).toBeGreaterThan(0);
  });

  it("returns ratio=0/tone=neutral when both sides are zero", () => {
    const flat = computeDelta(0, 0, "normal");
    expect(flat.ratio).toBe(0);
    expect(flat.tone).toBe("neutral");
  });

  it("returns ratio=null when prior window had no activity but current does", () => {
    const empty = computeDelta(10, 0, "normal");
    expect(empty.ratio).toBeNull();
  });
});
