// Tests for the `agent` tool surface. Covers schema validation,
// defaultDisabled behaviour, missing-host fallback, and the
// round-trip through a mocked spawnSubagent.

import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import type { AgentDefinition } from "@swarm/types";
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

  test("mocked spawnSubagent round-trips: returns { text: summary, data: { subagent_id, status, total_tool_calls } }", async () => {
    const env = new LocalEnvironment();
    const calls: SubagentSpec[] = [];
    const stubResult: SubagentResult = {
      summary: "child said hello",
      subagentId: "abc-123",
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
      { prompt: "summarise this", name: "summary", allowed_tools: ["read", "agent"] },
      env,
      { swarmContext },
    );

    expect(out.is_error).toBeFalsy();
    expect(out.text).toBe("child said hello");
    expect(out.data).toEqual({
      subagent_id: "abc-123",
      status: "completed",
      total_tool_calls: 3,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toBe("summarise this");
    expect(calls[0]?.name).toBe("summary");
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
        subagentId: "abc-999",
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

describe("agent tool — named-profile path", () => {
  function mkDef(name: string, extra: Partial<AgentDefinition> = {}): AgentDefinition {
    return {
      name,
      description: `desc for ${name}`,
      body: `body for ${name}`,
      location: `/tmp/${name}.md`,
      sha256: "0".repeat(64),
      bytes: 1,
      scope: "project",
      source_dir: "/tmp",
      ...extra,
    };
  }

  test("agent: <name> resolves a def from swarmContext.agentCatalog and merges fields", async () => {
    const env = new LocalEnvironment();
    const calls: SubagentSpec[] = [];
    const reviewer = mkDef("reviewer", {
      body: "be a reviewer",
      allowed_tools: ["read", "grep"],
      model: "claude-haiku-4-5",
      provider: "anthropic",
    });
    const swarmContext: SwarmToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as SwarmToolContext["http"],
      emit: () => {},
      agentCatalog: [reviewer],
      spawnSubagent: async (spec) => {
        calls.push(spec);
        return { summary: "ok", subagentId: "s1", status: "completed", totalToolCalls: 0 };
      },
    };
    const out = await agentTool.execute({ prompt: "please review", agent: "reviewer" }, env, { swarmContext });
    expect(out.is_error).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.system_prompt).toBe("be a reviewer");
    expect(calls[0]!.allowed_tools).toEqual(["read", "grep"]);
    expect(calls[0]!.model).toBe("claude-haiku-4-5");
    expect(calls[0]!.provider).toBe("anthropic");
    expect(calls[0]!.agentName).toBe("reviewer");
  });

  test("agent: <name> with inline overrides — inline wins per the resolution table", async () => {
    const env = new LocalEnvironment();
    const calls: SubagentSpec[] = [];
    const reviewer = mkDef("reviewer", { body: "def body", allowed_tools: ["read", "grep"] });
    const swarmContext: SwarmToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as SwarmToolContext["http"],
      emit: () => {},
      agentCatalog: [reviewer],
      spawnSubagent: async (spec) => {
        calls.push(spec);
        return { summary: "", subagentId: "s", status: "completed", totalToolCalls: 0 };
      },
    };
    await agentTool.execute(
      {
        prompt: "x",
        agent: "reviewer",
        system_prompt: "inline persona",
        allowed_tools: ["read"],
      },
      env,
      { swarmContext },
    );
    expect(calls[0]!.system_prompt).toBe("inline persona");
    expect(calls[0]!.allowed_tools).toEqual(["read"]);
  });

  test("agent: <unknown> returns is_error listing discovered names", async () => {
    const env = new LocalEnvironment();
    const swarmContext: SwarmToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as SwarmToolContext["http"],
      emit: () => {},
      agentCatalog: [mkDef("alpha"), mkDef("beta")],
      spawnSubagent: async () => {
        throw new Error("should not be called");
      },
    };
    const out = await agentTool.execute({ prompt: "x", agent: "missing" }, env, { swarmContext });
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("missing");
    expect(out.text).toContain("alpha");
    expect(out.text).toContain("beta");
  });

  test("inline allowed_tools with non-canonical entries are normalised before passing to spawnSubagent", async () => {
    const env = new LocalEnvironment();
    const calls: SubagentSpec[] = [];
    const swarmContext: SwarmToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as SwarmToolContext["http"],
      emit: () => {},
      spawnSubagent: async (spec) => {
        calls.push(spec);
        return { summary: "", subagentId: "s", status: "completed", totalToolCalls: 0 };
      },
    };
    await agentTool.execute({ prompt: "x", allowed_tools: ["Read", "WebFetch"] }, env, { swarmContext });
    expect(calls[0]!.allowed_tools).toEqual(["read", "web_fetch"]);
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
