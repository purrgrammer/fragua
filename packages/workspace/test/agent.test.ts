// Tests for the `agent` tool surface. Covers schema validation,
// defaultDisabled behaviour, missing-host fallback, and the
// round-trip through a mocked spawnSubagent.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { agentTool } from "../src/agent.ts";
import { LocalEnvironment } from "../src/local-env.ts";
import { CORE_TOOLS, stripAgentTool } from "../src/tools.ts";
import type { SubagentResult, SubagentSpec, SwarmToolContext } from "../src/types.ts";
import { ToolRegistry } from "../src/types.ts";

describe("agent tool", () => {
  test("TypeBox schema validates {prompt} with all optionals omitted", () => {
    expect(Value.Check(agentTool.parameters, { prompt: "do the thing" })).toBe(true);
  });

  test("TypeBox schema rejects missing prompt", () => {
    expect(Value.Check(agentTool.parameters, {})).toBe(false);
  });

  test("defaultDisabled keeps agent out of registry.select() default catch-all", () => {
    const r = new ToolRegistry();
    r.registerAll(CORE_TOOLS);
    const picked = r.select();
    expect(picked.map((t) => t.name)).not.toContain("agent");
  });

  test("select({ allow: ['agent'] }) bypasses defaultDisabled and includes agent", () => {
    const r = new ToolRegistry();
    r.registerAll(CORE_TOOLS);
    const picked = r.select({ allow: ["agent"] });
    expect(picked.map((t) => t.name)).toEqual(["agent"]);
  });

  test("is_error returned when swarmContext is missing", async () => {
    const env = new LocalEnvironment();
    const out = await agentTool.execute({ prompt: "x" }, env, {});
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("swarmContext.spawnSubagent");
  });

  test("is_error returned when swarmContext is present but spawnSubagent is undefined", async () => {
    const env = new LocalEnvironment();
    const swarmContext: SwarmToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as SwarmToolContext["http"],
      emit: () => {},
    };
    const out = await agentTool.execute({ prompt: "x" }, env, { swarmContext });
    expect(out.is_error).toBe(true);
  });

  test("mocked spawnSubagent round-trips: returns { text: summary, data: { child_run_id, status, total_tool_calls } }", async () => {
    const env = new LocalEnvironment();
    const calls: SubagentSpec[] = [];
    const stubResult: SubagentResult = {
      summary: "child said hello",
      childRunId: "conv-abc",
      status: "completed",
      totalToolCalls: 3,
    };
    const swarmContext: SwarmToolContext = {
      runId: "parent",
      nodeId: "plan",
      iteration: 0,
      http: {} as SwarmToolContext["http"],
      emit: () => {},
      spawnSubagent: async (spec) => {
        calls.push(spec);
        return stubResult;
      },
    };

    const out = await agentTool.execute(
      { prompt: "summarise this", description: "summary", allowed_tools: ["read", "agent"] },
      env,
      { swarmContext },
    );

    expect(out.is_error).toBeFalsy();
    expect(out.text).toBe("child said hello");
    expect(out.data).toEqual({
      child_run_id: "conv-abc",
      status: "completed",
      total_tool_calls: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("summarise this");
    expect(calls[0]?.description).toBe("summary");
    expect(calls[0]?.allowed_tools).toEqual(["read", "agent"]);
  });

  test("haltReason is surfaced under data.halt_reason and is_error flips to true", async () => {
    const env = new LocalEnvironment();
    const swarmContext: SwarmToolContext = {
      runId: "parent",
      nodeId: "plan",
      iteration: 0,
      http: {} as SwarmToolContext["http"],
      emit: () => {},
      spawnSubagent: async () => ({
        summary: "",
        childRunId: "conv-x",
        status: "halted",
        haltReason: "max_loops",
        totalToolCalls: 0,
      }),
    };

    const out = await agentTool.execute({ prompt: "x" }, env, { swarmContext });
    expect(out.is_error).toBe(true);
    const data = out.data as { halt_reason?: string };
    expect(data.halt_reason).toBe("max_loops");
  });
});

describe("stripAgentTool", () => {
  test("removes the `agent` tool from a pool", () => {
    const pool = stripAgentTool(CORE_TOOLS);
    expect(pool.map((t) => t.name)).not.toContain("agent");
    expect(pool.map((t) => t.name)).toContain("read");
  });

  test("is a no-op when `agent` isn't in the pool", () => {
    const pool = stripAgentTool(CORE_TOOLS.filter((t) => t.name !== "agent"));
    expect(pool.map((t) => t.name)).not.toContain("agent");
  });
});
