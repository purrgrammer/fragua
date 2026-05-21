// Tests for the `agent` tool surface. Covers schema validation,
// defaultDisabled behaviour, missing-host fallback, and the
// round-trip through a mocked spawnSubagent.

import { describe, expect, test } from "bun:test";
import type { AgentDefinition } from "@fragua/types";
import { Value } from "@sinclair/typebox/value";
import { agentTool } from "../src/agent.ts";
import { LocalEnvironment } from "../src/local-env.ts";
import { CORE_TOOLS, stripAgentTool } from "../src/tools.ts";
import type { FraguaToolContext, SubagentResult, SubagentSpec } from "../src/types.ts";
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

  test("is_error returned when fraguaContext is missing", async () => {
    const env = new LocalEnvironment();
    const out = await agentTool.execute({ prompt: "x" }, env, {});
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("fraguaContext.spawnSubagent");
  });

  test("is_error returned when fraguaContext is present but spawnSubagent is undefined", async () => {
    const env = new LocalEnvironment();
    const fraguaContext: FraguaToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
      emit: () => {},
    };
    const out = await agentTool.execute({ prompt: "x" }, env, { fraguaContext });
    expect(out.is_error).toBe(true);
  });

  test("is_error returned when tool_call_id is missing from execute opts", async () => {
    const env = new LocalEnvironment();
    const fraguaContext: FraguaToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
      emit: () => {},
      spawnSubagent: async () => ({ summary: "", subagentId: "x", status: "completed", totalToolCalls: 0 }),
    };
    const out = await agentTool.execute({ prompt: "x" }, env, { fraguaContext });
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("tool_call_id");
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
    const fraguaContext: FraguaToolContext = {
      runId: "parent",
      nodeId: "plan",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
      emit: () => {},
      spawnSubagent: async (spec) => {
        calls.push(spec);
        return stubResult;
      },
    };

    const out = await agentTool.execute(
      { prompt: "summarise this", name: "summary", allowed_tools: ["read", "agent"] },
      env,
      { fraguaContext, tool_call_id: "toolu_t1" },
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
    const fraguaContext: FraguaToolContext = {
      runId: "parent",
      nodeId: "plan",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
      emit: () => {},
      spawnSubagent: async () => ({
        summary: "",
        subagentId: "abc-999",
        status: "halted",
        haltReason: "max_loops",
        totalToolCalls: 0,
      }),
    };

    const out = await agentTool.execute({ prompt: "x" }, env, { fraguaContext, tool_call_id: "toolu_t2" });
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

  test("agent: <name> resolves a def from fraguaContext.agentCatalog and merges fields", async () => {
    const env = new LocalEnvironment();
    const calls: SubagentSpec[] = [];
    const reviewer = mkDef("reviewer", {
      body: "be a reviewer",
      allowed_tools: ["read", "grep"],
      model: "claude-haiku-4-5",
      provider: "anthropic",
    });
    const fraguaContext: FraguaToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
      emit: () => {},
      agentCatalog: [reviewer],
      spawnSubagent: async (spec) => {
        calls.push(spec);
        return { summary: "ok", subagentId: "s1", status: "completed", totalToolCalls: 0 };
      },
    };
    const out = await agentTool.execute({ prompt: "please review", agent: "reviewer" }, env, {
      fraguaContext,
      tool_call_id: "toolu_t3",
    });
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
    const fraguaContext: FraguaToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
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
      { fraguaContext, tool_call_id: "toolu_t4" },
    );
    expect(calls[0]!.system_prompt).toBe("inline persona");
    expect(calls[0]!.allowed_tools).toEqual(["read"]);
  });

  test("agent: <unknown> returns is_error listing discovered names", async () => {
    const env = new LocalEnvironment();
    const fraguaContext: FraguaToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
      emit: () => {},
      agentCatalog: [mkDef("alpha"), mkDef("beta")],
      spawnSubagent: async () => {
        throw new Error("should not be called");
      },
    };
    const out = await agentTool.execute({ prompt: "x", agent: "missing" }, env, {
      fraguaContext,
      tool_call_id: "toolu_t5",
    });
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("missing");
    expect(out.text).toContain("alpha");
    expect(out.text).toContain("beta");
  });

  test("inline allowed_tools with non-canonical entries are normalised before passing to spawnSubagent", async () => {
    const env = new LocalEnvironment();
    const calls: SubagentSpec[] = [];
    const fraguaContext: FraguaToolContext = {
      runId: "r",
      nodeId: "n",
      iteration: 0,
      http: {} as FraguaToolContext["http"],
      emit: () => {},
      spawnSubagent: async (spec) => {
        calls.push(spec);
        return { summary: "", subagentId: "s", status: "completed", totalToolCalls: 0 };
      },
    };
    await agentTool.execute({ prompt: "x", allowed_tools: ["Read", "WebFetch"] }, env, {
      fraguaContext,
      tool_call_id: "toolu_t6",
    });
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
