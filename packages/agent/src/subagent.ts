// local:subagent — spawns a nested Agent with its own fresh conversation,
// a limited tool set, and a strict timeout. Used for focused exploration/triage
// without polluting the parent's context.

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel, type Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ExecutionEnvironment, Tool, ToolRegistry } from "@swarm/workspace";
import { toAgentTool } from "./tool-adapter.ts";

export interface SubagentToolOptions {
  registry: ToolRegistry;
  env: ExecutionEnvironment;
  defaultModel: { provider: string; model: string };
  /** Override model resolution (tests use this to inject a faux-provider model). */
  resolveModel?: (provider: string, modelId: string) => Model<string>;
  /** System prompt for the subagent. */
  systemPrompt?: string;
  /** Response truncation cap before text reaches parent (chars). */
  maxResponseChars?: number;
}

export function createSubagentTool(opts: SubagentToolOptions): Tool<SubagentArgs, SubagentData> {
  const {
    registry,
    env,
    defaultModel,
    systemPrompt = "You are a focused sub-agent. Answer the user's prompt concisely.",
    maxResponseChars = 20_000,
  } = opts;
  // biome-ignore lint/suspicious/noExplicitAny: pi-ai's getModel is typed for KnownProvider; we accept custom providers.
  const resolveModel = opts.resolveModel ?? ((p: string, m: string) => (getModel as any)(p, m));

  return {
    name: "local:subagent",
    description:
      "Spawn a fresh sub-agent to handle a focused question. The sub-agent has its own conversation context, a limited tool set, and a strict timeout — it cannot recursively spawn further sub-agents. Use for exploration, triage, or research that would otherwise pollute your main context.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The question or task for the sub-agent." }),
      timeout_ms: Type.Optional(
        Type.Integer({ minimum: 1_000, maximum: 600_000, description: "Max wall-time (default 60000)." }),
      ),
      allowed_tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "Filter to this subset of tools. Default: all tools except local:subagent.",
        }),
      ),
      model: Type.Optional(Type.String({ description: "Override model id (default: parent's default)." })),
      provider: Type.Optional(Type.String({ description: "Override provider (default: parent's default)." })),
    }),
    idempotent: false,
    truncation: { max_chars: maxResponseChars, mode: "head_tail" },
    async execute(args) {
      const provider = args.provider ?? defaultModel.provider;
      const modelId = args.model ?? defaultModel.model;
      let model: Model<string>;
      try {
        model = resolveModel(provider, modelId);
      } catch (err) {
        return {
          text: `cannot resolve model "${provider}/${modelId}": ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      }
      if (!model) {
        return { text: `unknown model "${provider}/${modelId}"`, is_error: true };
      }

      // Fork bomb guard: strip local:subagent from the nested agent's tools.
      const allowed = args.allowed_tools;
      const tools = registry
        .list()
        .filter((t) => t.name !== "local:subagent")
        .filter((t) => !allowed || allowed.includes(t.name))
        .map((t) => toAgentTool(t, env));

      const agent = new Agent({
        initialState: { systemPrompt, model, tools },
      });

      const timeoutMs = args.timeout_ms ?? 60_000;
      const timer = setTimeout(() => agent.abort(), timeoutMs);

      try {
        await agent.prompt(args.prompt);
        await agent.waitForIdle();
      } catch (err) {
        return {
          text: `subagent crashed: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        };
      } finally {
        clearTimeout(timer);
      }

      const last = agent.state.messages.at(-1);
      if (!last || last.role !== "assistant") {
        return { text: "subagent produced no assistant response", is_error: true };
      }
      if (last.stopReason === "aborted") {
        return { text: `subagent aborted (timeout ${timeoutMs}ms)`, is_error: true };
      }
      if (last.stopReason === "error") {
        return { text: `subagent error: ${last.errorMessage ?? "unknown"}`, is_error: true };
      }

      return {
        text: extractAssistantText(last),
        data: { turns: agent.state.messages.length, stop_reason: String(last.stopReason ?? "end_turn") },
      };
    },
  };
}

interface SubagentArgs {
  prompt: string;
  timeout_ms?: number;
  allowed_tools?: string[];
  model?: string;
  provider?: string;
}

interface SubagentData {
  turns: number;
  stop_reason: string;
  [key: string]: string | number;
}

function extractAssistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  const parts = message.content as Array<{ type: string; text?: string }>;
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
}
