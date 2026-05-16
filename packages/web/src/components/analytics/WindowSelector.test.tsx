import { describe, expect, test } from "bun:test";
import { filterWindowOptions } from "./WindowSelector.tsx";

const DAY_MS = 86_400_000;

// Reference "now" anchored far enough in the future that Date.now()
// drift during the test run does not affect the assertions.
const NOW = 1_800_000_000_000;

describe("filterWindowOptions", () => {
  test("firstRunMs null renders only today and all", () => {
    const opts = filterWindowOptions(null, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("today");
    expect(keys).toContain("all");
    expect(keys).not.toContain("last7");
    expect(keys).not.toContain("last30");
    expect(keys).not.toContain("last90");
  });

  test("firstRunMs undefined renders only today and all", () => {
    const opts = filterWindowOptions(undefined, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("today");
    expect(keys).toContain("all");
    expect(keys).not.toContain("last7");
    expect(keys).not.toContain("last30");
    expect(keys).not.toContain("last90");
  });

  test("span < 7d hides every lastN option", () => {
    const firstRunMs = NOW - 6 * DAY_MS;
    const opts = filterWindowOptions(firstRunMs, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("today");
    expect(keys).toContain("all");
    expect(keys).not.toContain("last7");
    expect(keys).not.toContain("last30");
    expect(keys).not.toContain("last90");
  });

  test("span exactly 7d shows last7 only", () => {
    const firstRunMs = NOW - 7 * DAY_MS;
    const opts = filterWindowOptions(firstRunMs, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("today");
    expect(keys).toContain("all");
    expect(keys).toContain("last7");
    expect(keys).not.toContain("last30");
    expect(keys).not.toContain("last90");
  });

  test("span of 30d shows last7 and last30 but not last90", () => {
    const firstRunMs = NOW - 30 * DAY_MS;
    const opts = filterWindowOptions(firstRunMs, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("today");
    expect(keys).toContain("all");
    expect(keys).toContain("last7");
    expect(keys).toContain("last30");
    expect(keys).not.toContain("last90");
  });

  test("span of 90d shows every lastN option", () => {
    const firstRunMs = NOW - 90 * DAY_MS;
    const opts = filterWindowOptions(firstRunMs, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("today");
    expect(keys).toContain("all");
    expect(keys).toContain("last7");
    expect(keys).toContain("last30");
    expect(keys).toContain("last90");
  });

  test("today and all are always present regardless of span", () => {
    const spans = [null, 0, 1 * DAY_MS, 6 * DAY_MS, 7 * DAY_MS, 30 * DAY_MS, 90 * DAY_MS, 365 * DAY_MS];
    for (const span of spans) {
      const firstRunMs = span === null ? null : NOW - span;
      const opts = filterWindowOptions(firstRunMs, NOW);
      const keys = opts.map((o) => o.key);
      expect(keys).toContain("today");
      expect(keys).toContain("all");
    }
  });

  test("span between 7d and 30d (e.g. 15d) shows last7 only", () => {
    const firstRunMs = NOW - 15 * DAY_MS;
    const opts = filterWindowOptions(firstRunMs, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("last7");
    expect(keys).not.toContain("last30");
    expect(keys).not.toContain("last90");
  });

  test("span between 30d and 90d (e.g. 60d) shows last7 and last30 only", () => {
    const firstRunMs = NOW - 60 * DAY_MS;
    const opts = filterWindowOptions(firstRunMs, NOW);
    const keys = opts.map((o) => o.key);
    expect(keys).toContain("last7");
    expect(keys).toContain("last30");
    expect(keys).not.toContain("last90");
  });

  test("options are returned in WINDOWS order (today, last7, last30, last90, all)", () => {
    const firstRunMs = NOW - 90 * DAY_MS;
    const opts = filterWindowOptions(firstRunMs, NOW);
    expect(opts.map((o) => o.key)).toEqual(["today", "last7", "last30", "last90", "all"]);
  });
});
