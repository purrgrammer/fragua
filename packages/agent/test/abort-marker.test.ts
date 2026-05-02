// parseAbortMarker — the agent backend's self-abort contract.
//
// A workflow can wire an early-exit edge with `condition="outcome=fail"` and
// rely on agents emitting `<abort>reason</abort>` to terminate a run that
// cannot proceed (missing target, blocked precondition, etc.).
//
// Strict own-line semantics: the marker triggers iff it is the entire last
// non-empty line of the assistant's message. Mid-text occurrences (e.g.
// `<abort>` quoted as documentation in prose), prose-before-`<abort>` on
// the line, and trailing prose epilogues after `</abort>` all fail to
// match. The system-prompt `<protocol>` block teaches this discipline.

import { describe, expect, test } from "bun:test";
import { parseAbortMarker } from "../src/backend.ts";

describe("parseAbortMarker", () => {
  test("returns null when no marker present", () => {
    expect(parseAbortMarker("no markers here\njust prose")).toBeNull();
    expect(parseAbortMarker("")).toBeNull();
    // Stray `<promise>` tag (legacy convention) must not trigger.
    expect(parseAbortMarker("<promise>APPROVED</promise>")).toBeNull();
  });

  test("extracts the reason when <abort>…</abort> is the last line", () => {
    const r = parseAbortMarker("PLAN_BLOCKED: no target\n\n<abort>missing $ARGUMENTS</abort>");
    expect(r).toEqual({ reason: "missing $ARGUMENTS" });
  });

  test("case-insensitive on the tag when it's the entire last line", () => {
    const r = parseAbortMarker("preamble\n<ABORT>upper</ABORT>");
    expect(r?.reason).toBe("upper");
  });

  test("clamps very long reasons to 400 chars", () => {
    const long = "x".repeat(1000);
    const r = parseAbortMarker(`<abort>${long}</abort>`);
    expect(r?.reason.length).toBe(400);
  });

  test("empty <abort></abort> still aborts with a default reason", () => {
    const r = parseAbortMarker("<abort></abort>");
    expect(r).not.toBeNull();
    expect(r?.reason).toContain("without a reason");
  });

  test("when multiple markers appear on different lines, the trailing one wins", () => {
    // Earlier `<abort>…</abort>` instances on prior lines are documentation
    // (or prior turns the agent quoted). Only the trailing-line marker fires.
    const r = parseAbortMarker("<abort>first</abort>\n<abort>second</abort>");
    expect(r?.reason).toBe("second");
  });

  test("matches when the marker is followed only by trailing whitespace", () => {
    // Newlines / tabs / spaces after </abort> don't disqualify it — the
    // strict rule walks back through empty lines to find the marker.
    expect(parseAbortMarker("<abort>x</abort>\n\n")?.reason).toBe("x");
    expect(parseAbortMarker("<abort>x</abort>   \t\n  ")?.reason).toBe("x");
  });

  test("rejects prose before <abort> on the same line", () => {
    // Anything other than whitespace before the opening tag disqualifies
    // the line. Mid-prose `<abort>doc-only</abort>` is documentation.
    expect(parseAbortMarker("preamble <abort>upper</abort>")).toBeNull();
    expect(parseAbortMarker("intro <abort>doc-only</abort>")).toBeNull();
  });

  test("rejects content after </abort> on the same line", () => {
    expect(parseAbortMarker("<abort>doc-only</abort> rest of message")).toBeNull();
    expect(parseAbortMarker("<abort>doc-only</abort> outro")).toBeNull();
  });

  test("rejects trailing prose epilogue after a clean marker", () => {
    // The failure mode where the agent emits a clean abort then keeps
    // generating — strict last-non-empty-line catches this.
    expect(parseAbortMarker("<abort>ready</abort>\n\nactually one more thing…")).toBeNull();
    expect(parseAbortMarker("<abort>ready</abort>\nepilogue")).toBeNull();
  });

  test("rejects multi-line abort tags", () => {
    // A marker split across multiple lines is no longer an own-line
    // marker — the closing `</abort>` is alone on its line. Reasons
    // must fit on the same line as the tags.
    expect(parseAbortMarker("leading\n<abort>\n  multi-line\n  reason\n</abort>")).toBeNull();
  });

  test("ignores <abort> inside a fenced code block when the message ends with prose", () => {
    const codeBlockExample = [
      "Halt-reason taxonomy:",
      "```",
      'fact.run_halted reason="aborted_exit"  → <abort>…</abort> in codergen turn',
      "```",
      "summary line",
    ].join("\n");
    expect(parseAbortMarker(codeBlockExample)).toBeNull();
  });

  test("detects a trailing marker past the 4KB storage-clip window", () => {
    // The function itself has no clipping; the documented invariant for
    // callers is to pass the FULL assistant text. A trailing marker after
    // 8 KB of preamble must still trigger.
    const padding = "x".repeat(8000);
    const r = parseAbortMarker(`${padding}\n<abort>out-of-window reason</abort>`);
    expect(r?.reason).toBe("out-of-window reason");
  });

  test("collapses internal whitespace runs in the reason", () => {
    // Tabs / multi-space runs inside an own-line marker get normalised
    // to single spaces before clamping.
    const r = parseAbortMarker("<abort>foo\t\t  bar   baz</abort>");
    expect(r?.reason).toBe("foo bar baz");
  });
});
