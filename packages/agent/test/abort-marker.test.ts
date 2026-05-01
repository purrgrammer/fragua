// parseAbortMarker — the agent backend's self-abort contract.
//
// A workflow can wire an early-exit edge with `condition="outcome=fail"` and
// rely on agents emitting `<abort>reason</abort>` to terminate a run that
// cannot proceed (missing target, blocked precondition, etc.).
//
// Final-text-only semantics: the marker triggers iff its closing tag is the
// last non-whitespace token in the assistant's message. Mid-text occurrences
// (e.g. `<abort>` quoted as documentation inside a fenced code block) do NOT
// abort the run. This pins the contract written in
// `docs/handler-contract.md` §11 and prevents the self-referential failure
// mode where an agent describing `<abort>` halts itself.

import { describe, expect, test } from "bun:test";
import { parseAbortMarker } from "../src/backend.ts";

describe("parseAbortMarker", () => {
  test("returns null when no marker present", () => {
    expect(parseAbortMarker("no markers here\njust prose")).toBeNull();
    expect(parseAbortMarker("")).toBeNull();
    // Unrelated promise tag (used for loop completion) must not trigger.
    expect(parseAbortMarker("<promise>APPROVED</promise>")).toBeNull();
  });

  test("extracts the reason when <abort>…</abort> is the trailing marker", () => {
    const r = parseAbortMarker("PLAN_BLOCKED: no target\n\n<abort>missing $ARGUMENTS</abort>");
    expect(r).toEqual({ reason: "missing $ARGUMENTS" });
  });

  test("trims internal whitespace and collapses newlines inside the marker", () => {
    const r = parseAbortMarker("leading\n<abort>\n  multi-line\n  reason\n</abort>");
    expect(r?.reason).toBe("multi-line reason");
  });

  test("case-insensitive on the tag", () => {
    const r = parseAbortMarker("preamble <ABORT>upper</ABORT>");
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

  test("when multiple markers appear, the trailing one wins", () => {
    // Earlier <abort>…</abort> instances are documentation in this model;
    // only the trailing one is the live abort signal.
    const r = parseAbortMarker("<abort>first</abort> and <abort>second</abort>");
    expect(r?.reason).toBe("second");
  });

  test("matches when the marker is followed only by trailing whitespace", () => {
    // Newlines / tabs / spaces after </abort> don't disqualify it.
    expect(parseAbortMarker("<abort>x</abort>\n\n")?.reason).toBe("x");
    expect(parseAbortMarker("<abort>x</abort>   \t\n  ")?.reason).toBe("x");
  });

  test("ignores a marker mid-text when followed by other content", () => {
    // The introspect-collect failure case: agent quotes <abort> as docs in
    // the middle of a long inventory, then ends with prose / a different
    // sentinel. Pre-fix, this set outcomeStatus=fail; post-fix, null.
    expect(parseAbortMarker("<abort>doc-only</abort> rest of message")).toBeNull();
    expect(parseAbortMarker("intro <abort>doc-only</abort> outro")).toBeNull();
  });

  test("ignores <abort> inside a fenced code block when the message ends with prose or <promise>", () => {
    const codeBlockExample = [
      "Halt-reason taxonomy:",
      "```",
      'fact.run_halted reason="aborted_exit"  → <abort>…</abort> in codergen turn',
      "```",
      "<promise>INVENTORY_READY</promise>",
    ].join("\n");
    // Trailing close tag is `</promise>`, not `</abort>` — no abort.
    expect(parseAbortMarker(codeBlockExample)).toBeNull();
  });

  test("detects a trailing marker past the 4KB storage-clip window", () => {
    // The function itself has no clipping, so this passes in pure form —
    // but it documents the invariant the caller MUST honour: pass the
    // full assistant text. A trailing marker past the clip window must
    // still trigger.
    const padding = "x".repeat(8000);
    const r = parseAbortMarker(`${padding}\n<abort>out-of-window reason</abort>`);
    expect(r?.reason).toBe("out-of-window reason");
  });
});
