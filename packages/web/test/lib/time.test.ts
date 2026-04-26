// Unit tests for the time helpers. We pin the locale to "en-US" so
// assertions stay deterministic regardless of the host locale.

import { describe, expect, it } from "bun:test";
import { formatDate, formatDateTime, formatDuration, formatRelative, toDate, toIsoTitle } from "../../src/lib/time.ts";

const L = { locale: "en-US" } as const;

describe("toDate", () => {
  it("accepts ISO strings, epoch ms, and Date instances", () => {
    expect(toDate("2024-01-02T03:04:05Z")).toBeInstanceOf(Date);
    expect(toDate(0)).toBeInstanceOf(Date);
    expect(toDate(new Date())).toBeInstanceOf(Date);
  });

  it("returns null for null / undefined / empty / garbage", () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate("")).toBeNull();
    expect(toDate("not-a-date")).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("produces a human string for a valid ISO input", () => {
    const s = formatDateTime("2024-01-04T15:42:00Z", L);
    // Don't assert exact format (Intl wording drifts across ICU versions),
    // just that the year, a month string, and a time component are present.
    expect(s).toMatch(/2024/);
    expect(s).toMatch(/Jan/);
    expect(s).toMatch(/:/);
  });

  it("falls back to '—' on invalid input", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("nope")).toBe("—");
  });

  it("honours a custom fallback", () => {
    expect(formatDateTime(null, { ...L, fallback: "(none)" })).toBe("(none)");
  });
});

describe("formatDate", () => {
  it("renders date only", () => {
    const s = formatDate("2024-01-04T15:42:00Z", L);
    expect(s).toMatch(/Jan/);
    expect(s).toMatch(/2024/);
    // Time should be absent.
    expect(s).not.toMatch(/:/);
  });
});

describe("formatRelative", () => {
  const now = "2024-06-15T12:00:00Z";

  it("renders 'just now' for sub-45s differences", () => {
    expect(formatRelative("2024-06-15T11:59:30Z", { ...L, now })).toBe("just now");
    expect(formatRelative("2024-06-15T12:00:20Z", { ...L, now })).toBe("just now");
  });

  it("renders minutes for sub-hour differences", () => {
    const s = formatRelative("2024-06-15T11:55:00Z", { ...L, now });
    expect(s.toLowerCase()).toContain("minute");
  });

  it("renders hours for sub-day differences", () => {
    const s = formatRelative("2024-06-15T08:00:00Z", { ...L, now });
    expect(s.toLowerCase()).toContain("hour");
  });

  it("renders days for sub-week differences", () => {
    const s = formatRelative("2024-06-13T12:00:00Z", { ...L, now });
    expect(s.toLowerCase()).toContain("day");
  });

  it("falls back on invalid input", () => {
    expect(formatRelative(null, { ...L, now })).toBe("—");
  });

  it("supports future instants (in N units)", () => {
    const s = formatRelative("2024-06-15T13:00:00Z", { ...L, now });
    expect(s.toLowerCase()).toContain("hour");
  });
});

describe("toIsoTitle", () => {
  it("returns the ISO string for a valid date", () => {
    expect(toIsoTitle("2024-01-04T15:42:00Z")).toBe("2024-01-04T15:42:00.000Z");
  });

  it("returns empty string for invalid input", () => {
    expect(toIsoTitle(null)).toBe("");
    expect(toIsoTitle("nope")).toBe("");
  });
});

describe("formatDuration", () => {
  it("milliseconds for sub-second durations", () => {
    // Instant finalisation steps (e.g. a `merge` whose events flush in
    // 8ms) need to render as "8ms" rather than rounding to a misleading
    // "0s". The cutoff is strictly < 1000 — exactly 1000ms is "1s".
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(8)).toBe("8ms");
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1s");
  });

  it("seconds-only for <60s", () => {
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(59_900)).toBe("1m"); // rounds to 60s → 1m
  });

  it("minutes/seconds for <1h", () => {
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(180_000)).toBe("3m");
  });

  it("hours/minutes for ≥1h", () => {
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });

  it("falls back for null/negative/NaN", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(undefined)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
    expect(formatDuration(Number.NaN)).toBe("—");
  });
});
