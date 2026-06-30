// Harness update notice — pure-function units: cache freshness, the
// should-we-check gate, and the single-line decision. The network fetch and the
// cache file I/O are thin and untested.

import { describe, expect, test } from "bun:test";
import { decideUpdateNotice, isCacheFresh, shouldCheckForUpdates, UPDATE_CHECK_TTL_MS } from "../src/update-notice.ts";

const NOW = 1_700_000_000_000;

describe("isCacheFresh", () => {
  test("absent cache is never fresh", () => {
    expect(isCacheFresh(undefined, NOW)).toBe(false);
  });

  test("within TTL is fresh", () => {
    expect(isCacheFresh({ checkedAt: NOW - 1000, latestTag: "0.9.0" }, NOW)).toBe(true);
  });

  test("just past TTL is stale", () => {
    expect(isCacheFresh({ checkedAt: NOW - UPDATE_CHECK_TTL_MS - 1, latestTag: "0.9.0" }, NOW)).toBe(false);
  });

  test("exactly at TTL boundary is stale", () => {
    expect(isCacheFresh({ checkedAt: NOW - UPDATE_CHECK_TTL_MS, latestTag: "0.9.0" }, NOW)).toBe(false);
  });

  test("future-dated entry (clock skew) is stale", () => {
    expect(isCacheFresh({ checkedAt: NOW + 5000, latestTag: "0.9.0" }, NOW)).toBe(false);
  });

  test("non-finite timestamp is stale", () => {
    expect(isCacheFresh({ checkedAt: Number.NaN, latestTag: "0.9.0" }, NOW)).toBe(false);
  });
});

describe("shouldCheckForUpdates", () => {
  test("enabled by default (unset config, not dev, no pin)", () => {
    expect(shouldCheckForUpdates({ checkForUpdates: undefined, pin: undefined, isDev: false })).toBe(true);
  });

  test("explicit true checks", () => {
    expect(shouldCheckForUpdates({ checkForUpdates: true, pin: undefined, isDev: false })).toBe(true);
  });

  test("disabled via config skips", () => {
    expect(shouldCheckForUpdates({ checkForUpdates: false, pin: undefined, isDev: false })).toBe(false);
  });

  test("a version pin skips", () => {
    expect(shouldCheckForUpdates({ checkForUpdates: undefined, pin: "0.8.0", isDev: false })).toBe(false);
  });

  test("dev build skips", () => {
    expect(shouldCheckForUpdates({ checkForUpdates: undefined, pin: undefined, isDev: true })).toBe(false);
  });
});

describe("decideUpdateNotice", () => {
  const base = { checkForUpdates: undefined, pin: undefined, isDev: false } as const;

  test("emits one line when a newer release exists", () => {
    expect(decideUpdateNotice({ ...base, current: "0.8.0", latestTag: "0.9.0" })).toBe(
      "fragua 0.9.0 available (you're on 0.8.0) · run `fragua upgrade`",
    );
  });

  test("tolerates a leading v on the tag", () => {
    expect(decideUpdateNotice({ ...base, current: "0.8.0", latestTag: "v0.9.0" })).toBe(
      "fragua 0.9.0 available (you're on 0.8.0) · run `fragua upgrade`",
    );
  });

  test("no notice when already on the latest", () => {
    expect(decideUpdateNotice({ ...base, current: "0.9.0", latestTag: "0.9.0" })).toBeUndefined();
  });

  test("no notice when current is newer than latest", () => {
    expect(decideUpdateNotice({ ...base, current: "0.10.0", latestTag: "0.9.0" })).toBeUndefined();
  });

  test("no notice when latest tag is unknown", () => {
    expect(decideUpdateNotice({ ...base, current: "0.8.0", latestTag: undefined })).toBeUndefined();
    expect(decideUpdateNotice({ ...base, current: "0.8.0", latestTag: "  " })).toBeUndefined();
  });

  test("no notice when disabled in config, even with a newer release", () => {
    expect(
      decideUpdateNotice({
        current: "0.8.0",
        latestTag: "0.9.0",
        checkForUpdates: false,
        pin: undefined,
        isDev: false,
      }),
    ).toBeUndefined();
  });

  test("no notice when a version pin is set", () => {
    expect(
      decideUpdateNotice({
        current: "0.8.0",
        latestTag: "0.9.0",
        checkForUpdates: undefined,
        pin: "0.8.0",
        isDev: false,
      }),
    ).toBeUndefined();
  });

  test("no notice in a dev build", () => {
    expect(
      decideUpdateNotice({
        current: "0.8.0",
        latestTag: "0.9.0",
        checkForUpdates: undefined,
        pin: undefined,
        isDev: true,
      }),
    ).toBeUndefined();
  });
});
