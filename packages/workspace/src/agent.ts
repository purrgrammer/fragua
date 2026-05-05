// `agent` tool \u2014 LLM-spawnable sub-agents via conversation runs.
//
// Mirrors Claude Code's Agent tool shape: the LLM constructs a prompt
// (the only context the sub-agent sees), names its tool pool + skills
// inline, and gets back the sub-agent's final assistant text plus a
// reference to the child run for replay.
//
// `defaultDisabled: true` keeps `agent` out of every node's tool set
// unless the workflow opts in via `allowed_tools="\u2026,agent"`. The host
// (the daemon's per-call codergen context) wires `swarmContext.spawnSubagent`;
// without it the tool returns an `is_error` so the LLM sees a clear
// "host doesn't support sub-agents" signal rather than a silent stall.

import { Type } from "@sinclair/typebox";
import type { SubagentSpec, Tool } from "./types.ts";

export interface AgentToolArgs {
  description?: string;
  prompt: string;
  system_prompt?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  skills?: string[];
  max_iterations?: number;
}

export interface AgentToolData {
  child_run_id: string;
  status: string;
  halt_reason?: string;
  total_tool_calls: number;
}

export const agentTool: Tool<AgentToolArgs, AgentToolData> = {
  name: "agent",
  description:
    "Spawn an isolated sub-agent that runs in its own context window. The sub-agent sees only the `prompt` you provide \u2014 no parent transcript. It runs in its own `run_id` (kind='conversation') with full event-stream replay; you receive only its final assistant message. `agent` itself is structurally stripped from the sub-agent's tool pool (no nesting). Use to delegate a self-contained task with a fresh context window.",
  parameters: Type.Object(
    {
      description: Type.Optional(
        Type.String({ description: "Optional 1-line label for UI / events; helpful for trace navigation." }),
      ),
      prompt: Type.String({
        description: "The only context the sub-agent will see. Construct it to be self-contained.",
      }),
      system_prompt: Type.Optional(
        Type.String({
          description: "Override the parent's system prompt. Omit to inherit the parent's verbatim.",
        }),
      ),
      allowed_tools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Allowlist for the sub-agent's tool pool. Defaults to the parent's effective pool minus `agent`.",
        }),
      ),
      disallowed_tools: Type.Optional(
        Type.Array(Type.String(), { description: "Denylist applied after the allowlist." }),
      ),
      skills: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Skill names to inject into the sub-agent's catalog. Resolved against the parent's loaded skills; unknown names are silently dropped.",
        }),
      ),
      max_iterations: Type.Optional(
        Type.Number({
          description: "Hard cap on agent loop iterations. Defaults to the parent's remaining budget.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  idempotent: false,
  defaultDisabled: true,
  truncation: { max_chars: 50_000, mode: "tail" },
  async execute(args, _env, opts) {
    const ctx = opts?.swarmContext;
    if (ctx?.spawnSubagent == null) {
      return {
        text: "agent tool requires host wiring \u2014 swarmContext.spawnSubagent is missing. This usually means the runtime didn't supply a sub-agent factory (tests/extensions hosts often skip it).",
        is_error: true,
      };
    }

    try {
      const spec: SubagentSpec = { prompt: args.prompt };
      if (args.description !== undefined) spec.description = args.description;
      if (args.system_prompt !== undefined) spec.system_prompt = args.system_prompt;
      if (args.allowed_tools !== undefined) spec.allowed_tools = args.allowed_tools;
      if (args.disallowed_tools !== undefined) spec.disallowed_tools = args.disallowed_tools;
      if (args.skills !== undefined) spec.skills = args.skills;
      if (args.max_iterations !== undefined) spec.max_iterations = args.max_iterations;
      if (opts?.signal !== undefined) spec.signal = opts.signal;

      const result = await ctx.spawnSubagent(spec);
      const data: AgentToolData = {
        child_run_id: result.childRunId,
        status: result.status,
        total_tool_calls: result.totalToolCalls,
      };
      if (result.haltReason !== undefined) data.halt_reason = result.haltReason;
      return {
        text:
          result.summary.length > 0
            ? result.summary
            : `(sub-agent terminated with status=${result.status} and produced no final message)`,
        data,
        is_error: result.status !== "completed",
      };
    } catch (err) {
      return {
        text: err instanceof Error ? err.message : String(err),
        is_error: true,
      };
    }
  },
};
