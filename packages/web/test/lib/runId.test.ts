import { describe, expect, test } from "vitest";
import { shortRunId } from "../../src/lib/runId.ts";

describe("shortRunId", () => {
  test("ULIDs render as prefix…suffix", () => {
    expect(shortRunId("01kqaf0vn58260drne")).toBe("01kq…drne");
    expect(shortRunId("01kqaf0xdn8zsnqzae")).toBe("01kq…qzae");
  });

  test("disambiguates two ULIDs queued in the same second", () => {
    // Both ULIDs share the leading 8 chars (timestamp). The old slice(0,8)
    // collapsed them to the same string; shortRunId must keep them distinct.
    const a = "01kqaf0w393cbd7n9g";
    const b = "01kqaf0whe6pwspg8q";
    expect(a.slice(0, 8)).toBe(b.slice(0, 8)); // pre-fix collision
    expect(shortRunId(a)).not.toBe(shortRunId(b));
  });

  test("returns the full id when it's too short to abbreviate", () => {
    expect(shortRunId("short")).toBe("short");
    expect(shortRunId("01abcd")).toBe("01abcd");
    expect(shortRunId("")).toBe("");
  });

  test("borderline length: exactly prefix+suffix is not abbreviated", () => {
    // 8 chars: 4 prefix + 4 suffix would leave no room for the ellipsis
    // to actually save space. Helper should leave it alone.
    expect(shortRunId("abcdefgh")).toBe("abcdefgh");
  });

  test("9-char id is abbreviated (one character beyond the threshold)", () => {
    expect(shortRunId("abcdefghi")).toBe("abcd…fghi");
  });
});
