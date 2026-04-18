// Wave 2b: the server's summary reducer surfaces the auto-generated
// pipeline title + the raw $ARGUMENTS so the web UI's PipelinesList /
// PipelineDetail / Home row layouts have consistent fallbacks.

import { describe, expect, test } from "bun:test";
import type { Event } from "@swarm/core";
import { deriveSummary, deriveTitle } from "../../src/lib/summary.ts";

function ev(type: string, data: Record<string, unknown>, timestamp = "2026-04-18T00:00:00.000Z"): Event {
  return { run_id: "r1", type: type as Event["type"], timestamp, workflow_sha: "sha", data };
}

describe("deriveTitle — latest-wins pick", () => {
  test("returns undefined when no pipeline.title_generated is present", () => {
    expect(deriveTitle([ev("pipeline.started", {})])).toBeUndefined();
  });

  test("picks the title from the event", () => {
    const events: Event[] = [
      ev("pipeline.started", {}),
      ev("pipeline.title_generated", { title: "Add list_dir tool", summary_node_id: "__summary.title" }),
    ];
    expect(deriveTitle(events)).toBe("Add list_dir tool");
  });

  test("a backfill-appended title overrides an earlier one (latest wins)", () => {
    const events: Event[] = [
      ev("pipeline.title_generated", { title: "First pass" }),
      ev("pipeline.title_generated", { title: "Better title", backfilled: true }),
    ];
    expect(deriveTitle(events)).toBe("Better title");
  });
});

describe("deriveSummary — title + input plumbing", () => {
  test("plumbs title + input onto the summary payload", () => {
    const events: Event[] = [
      ev("pipeline.started", { input: "add a local:list_dir tool" }),
      ev("pipeline.title_generated", { title: "Add list_dir tool", summary_node_id: "__summary.title" }),
      ev("pipeline.completed", { outcome: { status: "success" } }),
    ];
    const s = deriveSummary("r1", events);
    expect(s.title).toBe("Add list_dir tool");
    expect(s.input).toBe("add a local:list_dir tool");
  });

  test("missing input on pipeline.started → `input` omitted", () => {
    const s = deriveSummary("r1", [ev("pipeline.started", {})]);
    expect(s.input).toBeUndefined();
    expect(s.title).toBeUndefined();
  });
});
