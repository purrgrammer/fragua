import { describe, expect, test } from "bun:test";
import type { Event } from "@swarm/core";
import { foldSkillUsage, skillActivationsProjection } from "../src/projections/skill-activations.ts";

function ev(type: string, data: Record<string, unknown>): Event {
  return { run_id: "r1", type: type as Event["type"], timestamp: "2026-04-18T00:00:00Z", workflow_sha: "abc", data };
}

describe("skillActivationsProjection", () => {
  test("counts local:load_skill tool executions by skill name", () => {
    const events: Event[] = [
      ev("node.started", {}),
      ev("tool.execution_start", { tool_name: "local:load_skill", args: { name: "pdf" } }),
      ev("tool.execution_start", { tool_name: "local:load_skill", args: { name: "pdf" } }),
      ev("tool.execution_start", { tool_name: "local:load_skill", args: { name: "csv" } }),
    ];
    expect(skillActivationsProjection(events)).toEqual({
      pdf: { count: 2 },
      csv: { count: 1 },
    });
  });

  test("counts preload_skills on local:subagent", () => {
    const events: Event[] = [
      ev("tool.execution_start", {
        tool_name: "local:subagent",
        args: { preload_skills: ["pdf", "csv"] },
      }),
    ];
    expect(skillActivationsProjection(events)).toEqual({
      pdf: { count: 1 },
      csv: { count: 1 },
    });
  });

  test("does NOT count catalog-only advertisements (llm.start.skills[])", () => {
    const events: Event[] = [
      ev("llm.start", {
        skills: [
          { name: "pdf", sha256: "x", bytes: 100, scope: "user", source_dir: "/a", location: "/a/pdf/SKILL.md" },
        ],
      }),
    ];
    expect(skillActivationsProjection(events)).toEqual({});
  });

  test("ignores malformed tool.execution_start events gracefully", () => {
    const events: Event[] = [
      ev("tool.execution_start", { tool_name: "local:load_skill" }), // missing args
      ev("tool.execution_start", { tool_name: "local:load_skill", args: {} }), // missing name
      ev("tool.execution_start", { tool_name: "local:read_file", args: { path: "foo" } }), // different tool
    ];
    expect(skillActivationsProjection(events)).toEqual({});
  });
});

describe("foldSkillUsage", () => {
  test("aggregates across runs, deduping run ids", () => {
    const usage = foldSkillUsage([
      { runId: "r1", byRun: { pdf: { count: 2 } } },
      { runId: "r2", byRun: { pdf: { count: 1 }, csv: { count: 3 } } },
      { runId: "r3", byRun: {} },
    ]);
    expect(usage).toEqual({
      pdf: { runs: ["r1", "r2"], count: 3 },
      csv: { runs: ["r2"], count: 3 },
    });
  });
});
