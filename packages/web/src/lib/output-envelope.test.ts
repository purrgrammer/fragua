import { describe, expect, test } from "vitest";
import { stripOutputEnvelopes } from "./output-envelope.ts";

// A real digest-shaped id: the tags carry a sha256 of the wrapped value, so a
// short placeholder would not exercise the length the pattern pins.
const ID = "a".repeat(64);

describe("stripOutputEnvelopes", () => {
  test("keeps the wrapped value and drops both tags", () => {
    const out = stripOutputEnvelopes(`Review this: <fragua_output_${ID}>the payload</fragua_output_${ID}>`);
    expect(out).toBe("Review this: the payload");
  });

  test("drops an unpaired open tag", () => {
    expect(stripOutputEnvelopes(`<fragua_output_${ID}>truncated mid-value`)).toBe("truncated mid-value");
  });

  test("strips every envelope in a prompt that interpolates several", () => {
    const b = "b".repeat(64);
    const text =
      `spec: <fragua_output_${ID}>one</fragua_output_${ID}> ` + `paths: <fragua_output_${b}>two</fragua_output_${b}>`;
    expect(stripOutputEnvelopes(text)).toBe("spec: one paths: two");
    expect(stripOutputEnvelopes(text)).not.toContain("fragua_output");
  });

  test("leaves ordinary text with angle brackets alone", () => {
    // The value itself routinely contains markup and shell redirects; only the
    // envelope's own fixed shape may be removed.
    const text = "run `npm build > out.log` and check <div> and <fragua_output_short>";
    expect(stripOutputEnvelopes(text)).toBe(text);
  });
});
