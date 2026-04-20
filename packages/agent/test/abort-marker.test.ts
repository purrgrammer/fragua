// parseAbortMarker — the agent backend's self-abort contract.
//
// A workflow can wire an early-exit edge with `condition="outcome=fail"` and
// rely on agents emitting `<abort>reason</abort>` to terminate a run that
// cannot proceed (missing target, blocked precondition, etc.). This test
// pins the exact shape of what's accepted and what's stripped.

import { describe, expect, test } from "bun:test";
import { parseAbortMarker } from "../src/backend.ts";

describe("parseAbortMarker", () => {
  test("returns null when no marker present", () => {
    expect(parseAbortMarker("no markers here\njust prose")).toBeNull();
    expect(parseAbortMarker("")).toBeNull();
    // Unrelated promise tag (used for loop completion) must not trigger.
    expect(parseAbortMarker("<promise>APPROVED</promise>")).toBeNull();
  });

  test("extracts the reason from <abort>…</abort>", () => {
    const r = parseAbortMarker("PLAN_BLOCKED: no target\n\n<abort>missing $ARGUMENTS</abort>");
    expect(r).toEqual({ reason: "missing $ARGUMENTS" });
  });

  test("trims whitespace and collapses internal newlines", () => {
    const r = parseAbortMarker("leading\n<abort>\n  multi-line\n  reason\n</abort>\ntrailing");
    expect(r?.reason).toBe("multi-line reason");
  });

  test("case-insensitive on the tag", () => {
    const r = parseAbortMarker("text <ABORT>upper</ABORT> text");
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

  test("picks the first marker when multiple appear", () => {
    const r = parseAbortMarker("<abort>first</abort> and <abort>second</abort>");
    expect(r?.reason).toBe("first");
  });

  test("detects a marker past the 4KB storage-clip window", () => {
    // Regression: the backend used to feed `parseAbortMarker` the
    // 4KB-clipped `notes` string, which masked `<abort>` tags emitted at
    // the end of long assistant turns (hundreds of tool-call-like text
    // blocks before the agent gave up). The function itself has no
    // clipping, so this passes in pure form — but it documents the
    // invariant the caller MUST honour: pass the full assistant text.
    const padding = "x".repeat(8000);
    const r = parseAbortMarker(`${padding}\n<abort>out-of-window reason</abort>`);
    expect(r?.reason).toBe("out-of-window reason");
  });
});
