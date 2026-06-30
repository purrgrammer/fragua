// `fragua upgrade` — pure-function units: host target mapping, asset naming,
// SHA256SUMS digest lookup, tag normalization/comparison, and the
// decide-action policy. The `gh` calls and the rename are thin and untested.

import { describe, expect, test } from "bun:test";
import {
  assetDownloadUrl,
  assetName,
  compareVersions,
  decideAction,
  hostTarget,
  isDevBuild,
  lookupDigest,
  normalizeTag,
} from "../src/commands/upgrade.ts";

describe("hostTarget", () => {
  test("maps the four supported platform/arch pairs", () => {
    expect(hostTarget("linux", "x64")).toBe("bun-linux-x64");
    expect(hostTarget("linux", "arm64")).toBe("bun-linux-arm64");
    expect(hostTarget("darwin", "arm64")).toBe("bun-darwin-arm64");
    expect(hostTarget("darwin", "x64")).toBe("bun-darwin-x64");
  });

  test("throws with an actionable message for an unsupported pair", () => {
    expect(() => hostTarget("win32", "x64")).toThrow("no published binary for win32/x64");
    expect(() => hostTarget("linux", "ia32")).toThrow("no published binary for linux/ia32");
  });
});

describe("assetName", () => {
  test("builds the FULL binary asset name from a target", () => {
    expect(assetName("bun-linux-x64")).toBe("fragua-bun-linux-x64");
    expect(assetName("bun-darwin-arm64")).toBe("fragua-bun-darwin-arm64");
  });
});

describe("assetDownloadUrl", () => {
  test("builds the public release-download URL with the literal tag", () => {
    expect(assetDownloadUrl("purrgrammer/fragua", "v0.9.0", "fragua-bun-linux-x64")).toBe(
      "https://github.com/purrgrammer/fragua/releases/download/v0.9.0/fragua-bun-linux-x64",
    );
  });

  test("uses the tag literally — no v stripping", () => {
    expect(assetDownloadUrl("purrgrammer/fragua", "0.9.0", "SHA256SUMS")).toBe(
      "https://github.com/purrgrammer/fragua/releases/download/0.9.0/SHA256SUMS",
    );
    expect(assetDownloadUrl("purrgrammer/fragua", "v1.2.3", "SHA256SUMS")).toBe(
      "https://github.com/purrgrammer/fragua/releases/download/v1.2.3/SHA256SUMS",
    );
  });
});

describe("lookupDigest", () => {
  const sums = [
    "1111111111111111111111111111111111111111111111111111111111111111  fragua-bun-linux-x64",
    "2222222222222222222222222222222222222222222222222222222222222222  fragua-headless-bun-linux-x64",
    "3333333333333333333333333333333333333333333333333333333333333333  fragua-bun-darwin-arm64",
    "",
  ].join("\n");

  test("returns the digest for a present asset", () => {
    expect(lookupDigest(sums, "fragua-bun-linux-x64")).toBe(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(lookupDigest(sums, "fragua-bun-darwin-arm64")).toBe(
      "3333333333333333333333333333333333333333333333333333333333333333",
    );
  });

  test("does not confuse a prefix asset with its headless sibling", () => {
    expect(lookupDigest(sums, "fragua-headless-bun-linux-x64")).toBe(
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
  });

  test("returns null for a missing asset (fail-closed)", () => {
    expect(lookupDigest(sums, "fragua-bun-darwin-x64")).toBeNull();
  });

  test("lowercases and tolerates a binary-mode marker", () => {
    const blob = "ABCDEF0000000000000000000000000000000000000000000000000000000000 *fragua-bun-linux-arm64";
    expect(lookupDigest(blob, "fragua-bun-linux-arm64")).toBe(
      "abcdef0000000000000000000000000000000000000000000000000000000000",
    );
  });
});

describe("normalizeTag + compareVersions", () => {
  test("strips a single leading v", () => {
    expect(normalizeTag("v0.9.0")).toBe("0.9.0");
    expect(normalizeTag("0.9.0")).toBe("0.9.0");
    expect(normalizeTag("  v1.2.3  ")).toBe("1.2.3");
  });

  test("compares v-prefix tolerant", () => {
    expect(compareVersions("0.9.0", "v0.9.0")).toBe(0);
    expect(compareVersions("0.8.0", "0.9.0")).toBe(-1);
    expect(compareVersions("v0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  });

  test("treats the dev fallback as the lowest", () => {
    expect(compareVersions("0.0.0-dev", "0.1.0")).toBe(-1);
  });
});

describe("isDevBuild", () => {
  test("non-standalone entry is always dev", () => {
    expect(isDevBuild("0.9.0", false)).toBe(true);
  });

  test("dev fallback version is dev even when standalone", () => {
    expect(isDevBuild("0.0.0-dev", true)).toBe(true);
  });

  test("a real version in a standalone binary is not dev", () => {
    expect(isDevBuild("0.9.0", true)).toBe(false);
  });
});

describe("decideAction", () => {
  test("a pin without --to blocks", () => {
    expect(decideAction({ current: "0.8.0", resolved: "0.9.0", pin: "0.8.0", to: undefined })).toEqual({
      action: "blocked-by-pin",
      pin: "0.8.0",
    });
  });

  test("a pin with an explicit --to overrides the freeze", () => {
    expect(decideAction({ current: "0.8.0", resolved: "0.9.0", pin: "0.8.0", to: "0.9.0" })).toEqual({
      action: "upgrade",
    });
  });

  test("no-op when already on the resolved target", () => {
    expect(decideAction({ current: "0.9.0", resolved: "v0.9.0", pin: undefined, to: undefined })).toEqual({
      action: "noop",
    });
  });

  test("no-op when the current binary is newer than the target", () => {
    expect(decideAction({ current: "0.10.0", resolved: "0.9.0", pin: undefined, to: "0.9.0" })).toEqual({
      action: "noop",
    });
  });

  test("upgrades when behind the resolved target", () => {
    expect(decideAction({ current: "0.8.0", resolved: "0.9.0", pin: undefined, to: undefined })).toEqual({
      action: "upgrade",
    });
  });
});
