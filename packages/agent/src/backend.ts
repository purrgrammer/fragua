// PiCodergenBackend — CodergenBackend backed by pi-agent-core + pi-ai.

import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel, type Model } from "@mariozechner/pi-ai";
import type { CodergenBackend, CodergenInput, Outcome } from "@swarm/core";
import { fail, ok } from "@swarm/core";
import type { ExecutionEnvironment, ToolRegistry } from "@swarm/workspace";
import { bridgeAgentEvent, costPayload } from "./event-bridge.ts";
import { toAgentTool } from "./tool-adapter.ts";

export interface PiCodergenBackendOptions {
  registry: ToolRegistry;
  env: ExecutionEnvironment;
  /** Resolve an LLM model by provider + id. Defaults to pi-ai's getModel. */
  resolveModel?: (provider: string, modelId: string) => Model<string>;
  /** Model + provider used when a node doesn't specify them. */
  defaultModel?: { provider: string; model: string };
  /** Optional system prompt prepended to every run. Tests may omit this. */
  systemPrompt?: string;
}

export class PiCodergenBackend implements CodergenBackend {
  private readonly registry: ToolRegistry;
  private readonly env: ExecutionEnvironment;
  private readonly resolveModel: (provider: string, modelId: string) => Model<string>;
  private readonly defaultModel: { provider: string; model: string };
  private readonly systemPrompt: string;

  constructor(opts: PiCodergenBackendOptions) {
    this.registry = opts.registry;
    this.env = opts.env;
    // biome-ignore lint/suspicious/noExplicitAny: getModel is overloaded with KnownProvider; we intentionally accept any string so custom/faux providers work.
    this.resolveModel = opts.resolveModel ?? ((provider, modelId) => (getModel as any)(provider, modelId));
    this.defaultModel = opts.defaultModel ?? { provider: "anthropic", model: "claude-haiku-4-5" };
    this.systemPrompt = opts.systemPrompt ?? "";
  }

  async run(input: CodergenInput): Promise<Outcome> {
    const provider = input.node.attrs.provider ?? this.defaultModel.provider;
    const modelId = input.node.attrs.model ?? this.defaultModel.model;
    let model: Model<string> | undefined;
    try {
      model = this.resolveModel(provider, modelId);
    } catch (err) {
      return fail(`unknown model "${provider}/${modelId}": ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!model) {
      return fail(
        `model "${provider}/${modelId}" is not registered in pi-ai. ` +
          "Check spelling (OpenRouter uses dotted IDs like `anthropic/claude-opus-4.7`; Anthropic-direct uses hyphens like `claude-opus-4-7`). " +
          "Run `swarm providers` to list supported providers.",
      );
    }
    if (typeof model.api !== "string" || model.api === "" || model.api === "unknown") {
      return fail(`model "${provider}/${modelId}" has no valid API binding (api="${String(model.api)}").`);
    }

    const selectOpts: { allow?: string[]; deny?: string[] } = {};
    const allow = input.node.attrs.allowed_tools as string[] | undefined;
    const deny = input.node.attrs.denied_tools as string[] | undefined;
    if (allow) selectOpts.allow = allow;
    if (deny) selectOpts.deny = deny;
    const tools = this.registry.select(selectOpts).map((t) => toAgentTool(t, this.env));

    const agent = new Agent({
      initialState: { systemPrompt: this.systemPrompt, model, tools },
      ...(input.thread_id !== undefined ? { sessionId: input.thread_id } : {}),
    });

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      const bridged = bridgeAgentEvent(event);
      if (bridged && input.emit) await input.emit(bridged.type, bridged.data);
      if (event.type === "message_end" && event.message.role === "assistant" && input.emit) {
        await input.emit("cost.recorded", costPayload(event.message as AssistantMessage));
      }
    });

    try {
      await agent.prompt(input.prompt);
      await agent.waitForIdle();
    } finally {
      unsubscribe();
    }

    const last = agent.state.messages[agent.state.messages.length - 1];
    if (!last) return fail("agent produced no messages");

    if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      return fail(last.errorMessage ?? `agent stopped: ${last.stopReason}`, {
        notes: summarizeMessage(last),
      });
    }

    return ok({ notes: summarizeMessage(last) });
  }
}

function summarizeMessage(message: { role: string; content?: unknown }): string {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
  const parts = message.content as Array<{ type: string; text?: string }>;
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .slice(0, 4_000);
}
