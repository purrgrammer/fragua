// Default SummariserBackend — wraps pi-ai's `completeSimple` for a
// one-shot, no-tools compression call. Used by:
//
//   - execute() to generate the async pipeline title from $ARGUMENTS
//   - PiCodergenBackend to produce the tail for fidelity=summary:medium/high
//
// Each call rides as a synthetic node (see @swarm/core/types/summariser.ts).
// Events are emitted via the `emit` callback on SummariseInput so the
// envelope carries the synthetic node_id and a caller-side run_id /
// workflow_sha. No state persists between calls — the backend is a pure
// adapter.

import { type AssistantMessage, completeSimple, getModel, type Message, type Model } from "@mariozechner/pi-ai";
import type { SummariseInput, SummariseOutput, SummariserBackend } from "@swarm/core";
import { costPayload } from "./event-bridge.ts";

export interface PiSummariserBackendOptions {
  /** Provider id passed to pi-ai (`anthropic`, `openai`, `openrouter`, …). */
  provider: string;
  /** Model id on that provider. Cheap-tier model by default — the whole
   * point of a separate summariser is to avoid paying the coding model's
   * rate for compression work. */
  model: string;
  /** Override model resolution (tests). */
  resolveModel?: (provider: string, modelId: string) => Model<string>;
  /** Default cap on the generated summary length. `SummariseInput.max_output_tokens`
   * wins when set. */
  default_max_output_tokens?: number;
}

/** Small but conservative defaults. The runtime picks one from the CLI /
 * workflow attrs; this const exists so `resolveDefaults("anthropic")`
 * gives a sensible answer for the "user just set ANTHROPIC_API_KEY and
 * ran swarm" path. */
export const DEFAULT_SUMMARISER_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4o-mini",
  openrouter: "anthropic/claude-haiku-4.5",
  google: "gemini-2.5-flash",
  groq: "llama-3.1-8b-instant",
  cerebras: "llama-3.1-8b-instant",
};

export function defaultSummariserModel(provider: string): string | undefined {
  return DEFAULT_SUMMARISER_MODEL_BY_PROVIDER[provider];
}

const DEFAULT_MAX_OUTPUT_TOKENS = 512;

export class PiSummariserBackend implements SummariserBackend {
  private readonly provider: string;
  private readonly modelId: string;
  private readonly resolveModel: (provider: string, modelId: string) => Model<string>;
  private readonly defaultMaxOutputTokens: number;

  constructor(opts: PiSummariserBackendOptions) {
    this.provider = opts.provider;
    this.modelId = opts.model;
    // biome-ignore lint/suspicious/noExplicitAny: getModel is overloaded by KnownProvider; we accept any string so OpenRouter / faux providers work.
    this.resolveModel = opts.resolveModel ?? ((provider, modelId) => (getModel as any)(provider, modelId));
    this.defaultMaxOutputTokens = opts.default_max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async summarise(input: SummariseInput): Promise<SummariseOutput> {
    const started = Date.now();
    const systemPrompt = systemPromptFor(input);
    const userContent = userContentFor(input);
    const maxOutputTokens = input.max_output_tokens ?? this.defaultMaxOutputTokens;

    // Synthetic-node emit always runs under this summariser's node_id. Falls
    // back to a no-op when the caller didn't pass one (unit tests that want
    // just the text output).
    const emit = input.emit ?? (async () => {});

    await emit(
      "summary.started",
      dropUndefined({
        purpose: input.purpose,
        provider: this.provider,
        model: this.modelId,
        caller_node_id: input.caller_node_id,
        iteration: input.iteration,
        fidelity: input.fidelity,
      }),
      input.synthetic_node_id,
    );

    let model: Model<string> | undefined;
    try {
      model = this.resolveModel(this.provider, this.modelId);
    } catch (err) {
      return this.failOut(
        input,
        started,
        `unknown model "${this.provider}/${this.modelId}": ${stringifyErr(err)}`,
        emit,
      );
    }
    if (!model || typeof model.api !== "string" || model.api === "" || model.api === "unknown") {
      return this.failOut(
        input,
        started,
        `model "${this.provider}/${this.modelId}" is not registered or has no valid api binding`,
        emit,
      );
    }

    const messages: Message[] = [{ role: "user", content: userContent, timestamp: Date.now() }];

    let assistant: AssistantMessage;
    try {
      assistant = await completeSimple(
        model,
        { systemPrompt, messages, tools: [] },
        // biome-ignore lint/suspicious/noExplicitAny: provider-specific maxTokens knob; pi-ai accepts it as an opaque options bag.
        { signal: input.signal, maxTokens: maxOutputTokens } as any,
      );
    } catch (err) {
      return this.failOut(input, started, `summariser call failed: ${stringifyErr(err)}`, emit);
    }

    const text = extractText(assistant).trim();
    const usage = assistant.usage;
    const duration_ms = Date.now() - started;

    // Emit a cost.recorded under the synthetic node so the run-level cost
    // ledger picks this summariser call up without any bespoke aggregation.
    // Reuses the existing costPayload shape for schema back-compat.
    await emit("cost.recorded", costPayload(assistant), input.synthetic_node_id);

    const output: SummariseOutput = {
      text,
      ok: assistant.stopReason !== "error",
      provider: this.provider,
      model: this.modelId,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cost_usd: usage.cost.total,
      duration_ms,
    };
    if (assistant.stopReason === "error" && assistant.errorMessage) output.error = assistant.errorMessage;

    await emit(
      "summary.completed",
      dropUndefined({
        purpose: input.purpose,
        provider: this.provider,
        model: this.modelId,
        caller_node_id: input.caller_node_id,
        iteration: input.iteration,
        fidelity: input.fidelity,
        input_tokens: output.input_tokens,
        output_tokens: output.output_tokens,
        cost_usd: output.cost_usd,
        duration_ms: output.duration_ms,
        output_text: output.text,
        error: output.error,
      }),
      input.synthetic_node_id,
    );

    return output;
  }

  private async failOut(
    input: SummariseInput,
    started: number,
    error: string,
    emit: NonNullable<SummariseInput["emit"]>,
  ): Promise<SummariseOutput> {
    const output: SummariseOutput = {
      text: "",
      ok: false,
      error,
      provider: this.provider,
      model: this.modelId,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      duration_ms: Date.now() - started,
    };
    await emit(
      "summary.completed",
      dropUndefined({
        purpose: input.purpose,
        provider: this.provider,
        model: this.modelId,
        caller_node_id: input.caller_node_id,
        iteration: input.iteration,
        fidelity: input.fidelity,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        duration_ms: output.duration_ms,
        output_text: "",
        error,
      }),
      input.synthetic_node_id,
    );
    return output;
  }
}

function systemPromptFor(input: SummariseInput): string {
  if (input.purpose === "title") {
    return [
      "You generate concise 3-8 word titles for automated pipelines.",
      "Output ONLY the title itself — no quotes, no trailing punctuation, no leading phrases like 'Title:'.",
      "Keep it human-readable and specific to the task. Plain English.",
    ].join("\n");
  }
  // fidelity
  return [
    "You produce a compressed summary of a prior conversation between an AI agent and a user.",
    "Preserve: the goal, explicit constraints, decisions already made, open questions, and any file paths / identifiers referenced.",
    "Drop: small talk, tool-call mechanics, and repeated information.",
    "Output plain prose (no bullet lists, no headings, no preamble). Be faithful — never invent details.",
  ].join("\n");
}

function userContentFor(input: SummariseInput): string {
  const goalFragment = input.goal ? `Goal: ${input.goal}\n\n` : "";
  if (input.purpose === "title") {
    return `${goalFragment}Pipeline input to title:\n${input.input}`;
  }
  return `${goalFragment}Prior conversation to compress:\n${input.input}`;
}

function extractText(msg: AssistantMessage): string {
  if (!Array.isArray(msg.content)) return "";
  const parts: string[] = [];
  for (const block of msg.content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function stringifyErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dropUndefined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}
