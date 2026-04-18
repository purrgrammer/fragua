// PiCodergenBackend — CodergenBackend backed by pi-agent-core + pi-ai.

import { open as openFile, stat as statFile } from "node:fs/promises";
import { join as joinPath } from "node:path";
import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import { type AssistantMessage, getModel, type Model } from "@mariozechner/pi-ai";
import type { CodergenBackend, CodergenInput, Outcome } from "@swarm/core";
import { fail, ok } from "@swarm/core";
import type { ExecutionEnvironment, ToolRegistry } from "@swarm/workspace";
import { bridgeAgentEvent, costPayload } from "./event-bridge.ts";
import { loadContextFiles, mergeSystemPrompt } from "./system-prompt.ts";
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
  /** Runs directory; if set, backend tails `<runsDir>/<run_id>/steering.jsonl`
   * and injects any new lines into the running agent via agent.steer(). */
  runsDir?: string;
  /** Steering poll interval in ms. Default 500. */
  steeringPollMs?: number;
}

export class PiCodergenBackend implements CodergenBackend {
  private readonly registry: ToolRegistry;
  private readonly env: ExecutionEnvironment;
  private readonly resolveModel: (provider: string, modelId: string) => Model<string>;
  private readonly defaultModel: { provider: string; model: string };
  private readonly systemPrompt: string;
  private readonly runsDir: string | undefined;
  private readonly steeringPollMs: number;

  constructor(opts: PiCodergenBackendOptions) {
    this.registry = opts.registry;
    this.env = opts.env;
    // biome-ignore lint/suspicious/noExplicitAny: getModel is overloaded with KnownProvider; we intentionally accept any string so custom/faux providers work.
    this.resolveModel = opts.resolveModel ?? ((provider, modelId) => (getModel as any)(provider, modelId));
    this.defaultModel = opts.defaultModel ?? { provider: "anthropic", model: "claude-opus-4-7" };
    this.systemPrompt = opts.systemPrompt ?? "";
    this.runsDir = opts.runsDir;
    this.steeringPollMs = opts.steeringPollMs ?? 500;
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

    const contextFiles = (input.node.attrs.context_files as string[] | undefined) ?? [];
    const { text: contextBlock, warnings, files: contextFileRecords } = await loadContextFiles(this.env, contextFiles);
    if (input.emit) {
      for (const msg of warnings) await input.emit("agent.warning", { message: msg });
    }
    const systemPrompt = mergeSystemPrompt(this.systemPrompt, contextBlock);

    const agent = new Agent({
      initialState: { systemPrompt, model, tools },
      ...(input.thread_id !== undefined ? { sessionId: input.thread_id } : {}),
    });

    // Emit the resolved LLM-call snapshot. This is the one durable record of
    // what the agent was actually asked — resolved user prompt + assembled
    // system prompt + model binding + prior messages + settings + context
    // file hashes. Fires once per backend.run() (once for a codergen node,
    // N times for a loop node with N iterations). Everything a UI / replay
    // consumer needs to reconstruct "what the agent saw at step N" lives
    // here. Adding fields is additive — schema_version on the envelope
    // only bumps on incompatible renames/removals.
    if (input.emit) {
      const llmStart: Record<string, unknown> = {
        provider,
        model: modelId,
        prompt: input.prompt,
        system_prompt: systemPrompt,
      };
      if (input.thread_id) llmStart["thread_id"] = input.thread_id;
      if (allow) llmStart["allowed_tools"] = allow;
      if (deny) llmStart["denied_tools"] = deny;
      if (input.iteration) llmStart["iteration"] = input.iteration;
      // Snapshot the transcript the agent is starting with. For a fresh
      // session this is []; for a thread_id that restored a prior
      // pi-agent-core session, this holds the prior turns the agent will
      // see alongside the new user prompt. JSON round-trip both detaches
      // from the live state and forces JSON-safety (images/tool-results
      // pass through as whatever shape they already serialise to).
      const priorMessages = agent.state.messages.map((m) => jsonSafe(m));
      if (priorMessages.length > 0) llmStart["messages"] = priorMessages;
      const settings = captureSettings(input.node.attrs);
      if (settings) llmStart["settings"] = settings;
      if (contextFileRecords.length > 0) llmStart["context_files"] = contextFileRecords;
      // Wave 1 placeholder: the ledger that populates real cumulative
      // values lands in Wave 4. Today we surface only the per-node /
      // per-run ceilings when a workflow author sets them, so UIs can
      // start rendering the "budget used / budget cap" strip.
      const budget = captureBudget(input.node.attrs);
      if (budget) llmStart["budget"] = budget;
      await input.emit("llm.start", llmStart);
    }

    const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
      const bridged = bridgeAgentEvent(event);
      if (bridged && input.emit) await input.emit(bridged.type, bridged.data);
      if (event.type === "message_end" && event.message.role === "assistant" && input.emit) {
        await input.emit("cost.recorded", costPayload(event.message as AssistantMessage));
      }
    });

    const steeringStop = this.runsDir ? await this.startSteeringPoller(agent, input.run_id, input.emit) : () => {};

    try {
      await agent.prompt(input.prompt);
      await agent.waitForIdle();
    } finally {
      steeringStop();
      unsubscribe();
    }

    const last = agent.state.messages[agent.state.messages.length - 1];
    if (!last) return fail("agent produced no messages");

    if (last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      return fail(last.errorMessage ?? `agent stopped: ${last.stopReason}`, {
        notes: summarizeMessage(last),
      });
    }

    // Self-abort: an agent may decide its task is unreachable (missing target,
    // contradictory constraints, external blocker) and emit `<abort>reason</abort>`.
    // Treating that as a `fail` outcome lets workflows wire an early-exit edge
    // with `condition="outcome=fail"` instead of forwarding the whole pipeline
    // through a no-op plan → implement → verify chain. We also flag it
    // `non_retryable` so the goal-gate retry machinery doesn't relaunch the
    // pipeline after an explicit stop.
    const notes = summarizeMessage(last);
    const aborted = parseAbortMarker(notes);
    if (aborted) return fail(aborted.reason, { notes, non_retryable: true });

    return ok({ notes });
  }

  /** Tail the steering file and inject new lines as user messages.
   * Returns a stop function that cancels polling. */
  private async startSteeringPoller(agent: Agent, run_id: string, emit: CodergenInput["emit"]): Promise<() => void> {
    if (!this.runsDir) return () => {};
    const filePath = joinPath(this.runsDir, run_id, "steering.jsonl");
    let offset = 0;
    let stopped = false;

    const tick = async (): Promise<void> => {
      if (stopped) return;
      try {
        const { size } = await statFile(filePath);
        if (size > offset) {
          const fh = await openFile(filePath, "r");
          try {
            const buf = Buffer.alloc(size - offset);
            await fh.read(buf, 0, buf.length, offset);
            offset = size;
            for (const line of buf.toString("utf8").split("\n")) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              let parsed: { message?: unknown };
              try {
                parsed = JSON.parse(trimmed);
              } catch {
                continue;
              }
              const msg = typeof parsed.message === "string" ? parsed.message : undefined;
              if (!msg) continue;
              agent.steer({
                role: "user",
                content: [{ type: "text", text: msg }],
                timestamp: Date.now(),
              });
              if (emit) await emit("steering.injected", { message: msg });
            }
          } finally {
            await fh.close();
          }
        }
      } catch {
        // file may not exist yet — keep polling
      }
    };

    // Fire one immediate tick so pre-existing messages are picked up before
    // the first interval expires.
    await tick();
    const timer = setInterval(tick, this.steeringPollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
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

/**
 * Parse the final assistant text for a self-abort marker. The agent signals
 * "I cannot proceed" by emitting `<abort>reason</abort>` anywhere in its
 * final message. The reason is trimmed and clamped to a single line so it
 * can be surfaced as a `failure_reason` without dragging in kilobytes of
 * reasoning. Returns `null` when no marker is present.
 *
 * Exported so workflows (and tests) can rely on the exact contract without
 * reimplementing regex matching.
 */
export function parseAbortMarker(text: string): { reason: string } | null {
  if (!text) return null;
  const m = text.match(/<abort>([\s\S]*?)<\/abort>/i);
  if (!m) return null;
  const raw = (m[1] ?? "").trim();
  // Collapse any internal newlines; cap length.
  const oneLine = raw.replace(/\s+/g, " ").slice(0, 400);
  return { reason: oneLine.length > 0 ? oneLine : "agent aborted without a reason" };
}

/** JSON round-trip a value so the captured copy is detached from live
 * agent state and guaranteed JSON-safe. Functions / symbols / undefineds
 * inside content blocks get stripped by JSON.stringify; anything that
 * throws falls back to a minimal record so a single unserialisable
 * message doesn't take down the whole snapshot. */
function jsonSafe(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    // Typical cause: a Symbol or BigInt lurking in content. The role is
    // still worth preserving.
    const role = (value as { role?: unknown } | null)?.role;
    return { role: typeof role === "string" ? role : "unknown", unserialisable: true };
  }
}

/** Read generation settings from node attrs, returning `undefined` when
 * nothing is set so `llm.start.settings` stays omitted rather than empty.
 * `reasoning_effort` is explicitly typed on `NodeAttrs`; the others live
 * in the `[extra: string]` bag and are picked up when present. */
function captureSettings(attrs: Record<string, unknown>):
  | {
      temperature?: number;
      max_tokens?: number;
      top_p?: number;
      reasoning_effort?: "low" | "medium" | "high";
      stop?: string[];
    }
  | undefined {
  const settings: {
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    reasoning_effort?: "low" | "medium" | "high";
    stop?: string[];
  } = {};
  if (typeof attrs["temperature"] === "number") settings.temperature = attrs["temperature"];
  if (typeof attrs["max_tokens"] === "number") settings.max_tokens = attrs["max_tokens"];
  if (typeof attrs["top_p"] === "number") settings.top_p = attrs["top_p"];
  const effort = attrs["reasoning_effort"];
  if (effort === "low" || effort === "medium" || effort === "high") settings.reasoning_effort = effort;
  const stop = attrs["stop"];
  if (Array.isArray(stop) && stop.every((s): s is string => typeof s === "string")) settings.stop = stop;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

/** Wave 1 budget snapshot: cumulative counters are placeholders (0) until
 * Wave 4 wires a BudgetLedger; the ceilings are populated opportunistically
 * when a workflow author sets them on the node. Returns `undefined` if
 * there is nothing useful to surface. */
function captureBudget(
  attrs: Record<string, unknown>,
): { cumulative_cost_usd: number; cumulative_tokens: number; max_cost_usd?: number } | undefined {
  const maxCost = typeof attrs["max_cost_usd"] === "number" ? attrs["max_cost_usd"] : undefined;
  // Wave 1 emits budget only when the author has actually set a ceiling,
  // otherwise the field is noise. Wave 4 will start emitting unconditionally
  // because the cumulative counters will then be meaningful.
  if (maxCost === undefined) return undefined;
  return { cumulative_cost_usd: 0, cumulative_tokens: 0, max_cost_usd: maxCost };
}
