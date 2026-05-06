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
import { lookupAgentDef } from "./agents/catalog.ts";
import { normaliseToolName } from "./agents/normalise.ts";
import type { SubagentSpec, Tool } from "./types.ts";

export interface AgentToolArgs {
  /** Optional resolved-profile name. When set, the named def's fields
   *  fill in unspecified slots; inline params on the same call
   *  override the def. Resolved against `swarmContext.agentCatalog`. */
  agent?: string;
  name?: string;
  prompt: string;
  system_prompt?: string;
  allowed_tools?: string[];
  disallowed_tools?: string[];
  skills?: string[];
  max_iterations?: number;
}

export interface AgentToolData {
  /** Per-spawn discriminator. Stamped on every observability event the
   *  sub-agent emitted (`subagent_id` payload field) and bracketed by
   *  `subagent.start` / `subagent.end` events on the parent's stream. */
  subagent_id: string;
  status: "completed" | "halted" | "cancelled";
  halt_reason?: string;
  total_tool_calls: number;
}

export const agentTool: Tool<AgentToolArgs, AgentToolData> = {
  name: "agent",
  description:
    "Spawn an isolated sub-agent that runs in its own context window. The sub-agent sees only the `prompt` you provide \u2014 no parent transcript. Its observability (`llm.start`, `llm.toolcall_*`, `cost.recorded`, `agent.turn_*`) lands on the parent's event stream with a `subagent_id` discriminator; cost rolls into the parent's metrics naturally. You receive only its final assistant message plus the discriminator. `agent` itself is structurally stripped from the sub-agent's tool pool (no nesting). Use to delegate a self-contained task with a fresh context window.",
  parameters: Type.Object(
    {
      agent: Type.Optional(
        Type.String({
          description:
            "Optional name of a discovered sub-agent profile (see the `## Available sub-agents` block in your system prompt, if present). When set, the profile's body becomes the sub-agent's system prompt and its `model` / `provider` / `allowed_tools` fill in any slots you didn't pass inline. Inline params on this call override the profile.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            'Optional short name for this sub-agent (e.g. "reviewer", "haiku-poet"). Surfaced in the UI as `Agent · <name>` and in `subagent.start` events for trace navigation. Keep it short — it\'s a label, not a sentence.',
        }),
      ),
      prompt: Type.String({
        description: "The only context the sub-agent will see. Construct it to be self-contained.",
      }),
      system_prompt: Type.Optional(
        Type.String({
          description:
            "Optional per-call system prompt. Omit to let the framework build a fresh minimal prompt for the sub-agent's own tool pool — the parent's full assembled prompt is NOT inherited (it would carry tools the sub-agent can't use).",
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
      // Resolve the named profile (if any) before building the spec.
      // Resolution rules per docs/proposals/agent-definitions.md
      // "Tool surface change" table: inline > def > inherit-parent.
      const catalog = ctx.agentCatalog ?? [];
      let def: ReturnType<typeof lookupAgentDef> | undefined;
      if (args.agent !== undefined) {
        def = lookupAgentDef(catalog, args.agent);
        if (def === undefined) {
          const names = catalog.filter((d) => !d.disabled_reason).map((d) => d.name);
          const list = names.length > 0 ? names.join(", ") : "(none discovered)";
          return {
            text: `unknown agent profile "${args.agent}". Available: ${list}.`,
            is_error: true,
          };
        }
      }

      // Inline `allowed_tools` are normalised too — keeps the surface
      // symmetric with the loader so Claude-style names
      // (`Read`, `WebFetch`) don't silently fail the intersection check.
      const inlineAllowed =
        args.allowed_tools !== undefined ? args.allowed_tools.map((t) => normaliseToolName(t).name) : undefined;

      const spec: SubagentSpec = { prompt: args.prompt };
      if (args.name !== undefined) spec.name = args.name;

      const systemPrompt = args.system_prompt ?? def?.body;
      if (systemPrompt !== undefined && systemPrompt.length > 0) spec.system_prompt = systemPrompt;

      // Explicit > implicit: the calling LLM must say what tools the
      // sub-agent can use. Inline `allowed_tools` wins; otherwise the
      // resolved profile must declare them. Without either, return an
      // immediate is_error so the LLM corrects the call cheaply
      // instead of running a sub-agent on the wrong pool — the
      // alternatives (inherit parent → silent narrowing if the parent
      // is read-only; default to do-work → silent widening for audit
      // workflows) both bit us in practice.
      const allowedTools = inlineAllowed ?? def?.allowed_tools;
      if (allowedTools === undefined) {
        return {
          text:
            "agent tool requires `allowed_tools` to be specified. " +
            "Pass an inline `allowed_tools: [\"read\", \"write\", \"edit\", \"bash\", ...]` argument, " +
            "or invoke a named profile (`agent: <name>`) whose frontmatter declares `allowed_tools` (or `tools`).",
          is_error: true,
        };
      }
      spec.allowed_tools = allowedTools;

      if (args.disallowed_tools !== undefined) spec.disallowed_tools = args.disallowed_tools;
      if (args.skills !== undefined) spec.skills = args.skills;
      if (args.max_iterations !== undefined) spec.max_iterations = args.max_iterations;

      if (def?.model !== undefined) spec.model = def.model;
      if (def?.provider !== undefined) spec.provider = def.provider;
      if (def !== undefined) spec.agentName = def.name;

      if (opts?.signal !== undefined) spec.signal = opts.signal;
      if (opts?.tool_call_id !== undefined) spec.tool_call_id = opts.tool_call_id;

      const result = await ctx.spawnSubagent(spec);
      const data: AgentToolData = {
        subagent_id: result.subagentId,
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
